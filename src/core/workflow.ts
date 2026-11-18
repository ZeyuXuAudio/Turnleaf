import { SyncService, PushPlan, PushFile, remoteTexts, reviewFingerprint } from './sync';
import { Cache } from './storage';
import { Inspection } from './models';
import { SavedTexts, readSaved, sameSaved, mergeSaved, replaceSaved } from './savedFiles';
import { SyncError } from './errors';
import { validateUpload } from './guard';
import { changedLines, diffText } from './diff';
import { mapDocument } from './ranges';
import { trackedInspection } from './review';
import { checkCancelled } from './operation';

export interface IncomingFile { path: string; before: string; after: string; base: string; remote: string; conflict: boolean; added: number; removed: number; }
export interface PullPlan {
  head: string; sourceBranch: string; snapshot?: string; baseline: string;
  inspection: Inspection; cache: Cache; saved: SavedTexts; proposed: SavedTexts; files: IncomingFile[];
}
export function sameRemote(a: Inspection, b: Inspection, cache: Cache): boolean {
  const documents = (i: Inspection) => JSON.stringify([...i.docs].sort((a, b) => a.path.localeCompare(b.path)).map(d => [d.path, d.docId, d.folderId, d.version, d.text]));
  return a.projectId === b.projectId && documents(a) === documents(b) && !b.missingFiles.length && reviewFingerprint(a, cache) === reviewFingerprint(b, cache) && a.userId === b.userId && a.trackChanges === b.trackChanges;
}

// Preview never advances the baseline or edits the user's index/working tree.
export class ReviewWorkflow {
  constructor(readonly sync: SyncService) {}
  async prepareSend(): Promise<PushPlan> {
    const s = this.sync;
    return s.git.exclusive(async () => {
      await s.git.init();
      const sourceBranch = await s.state.claimSnapshot(), cache = await s.state.cache();
      if (cache.localApply) throw new SyncError('Recover the interrupted local apply before reviewing another operation.', 'recovery');
      if (cache.partialPush) throw new SyncError('A previous send needs verification. Get latest before sending again.', 'incoming');
      const snapshot = await s.git.snapshot(), head = await s.git.head();
      if (!snapshot || cache.appliedSnapshot !== snapshot && !await s.git.merged(s.paths)) throw new SyncError('Get latest to establish the shared baseline before sending.', 'incoming');
      await s.git.assertSnapshotScope(snapshot, s.paths);
      const inspection = await s.fetchPull();
      if (!await s.git.matches(snapshot, remoteTexts(inspection))) throw new SyncError('Overleaf has incoming changes. Review and apply Get latest before sending.', 'incoming');
      const saved = await readSaved(s.git.root, s.paths), files: PushFile[] = [];
      for (const doc of trackedInspection(inspection, cache).docs) {
        const bytes = Buffer.from(saved[doc.path]!), text = validateUpload(doc.path, bytes);
        if (text === doc.text) continue;
        const diff = diffText(doc.text, text), mapping = mapDocument(doc, text, inspection.trackChanges, diff.diffs);
        mapping.slow = diff.slow;
        files.push({ doc, bytes, text, mapping, ...changedLines(diff.diffs) });
      }
      return { head, sourceBranch, snapshot, inspection, files, cache, saved };
    });
  }
  async preparePull(baseline?: string, fetched?: Inspection): Promise<PullPlan> {
    const s = this.sync;
    return s.git.exclusive(async () => {
      await s.git.init();
      const sourceBranch = await s.state.claimSnapshot(), cache = await s.state.cache();
      if (cache.localApply) throw new SyncError('Recover the interrupted local apply first.', 'recovery');
      const head = await s.git.head(), snapshot = await s.git.snapshot(), inspection = fetched ?? await s.fetchPull();
      if (inspection.missingFiles.length) throw new SyncError(`Missing Overleaf files: ${inspection.missingFiles.join(', ')}`, 'missing');
      if (snapshot) {
        await s.git.assertSnapshotScope(snapshot, s.paths);
        baseline = cache.appliedSnapshot ?? (await s.git.merged(s.paths) ? snapshot : await s.git.optional(['merge-base', head, snapshot]));
      } else baseline ??= await s.git.baseline(remoteTexts(inspection));
      if (!baseline) throw new SyncError('Choose the last shared commit to prepare the first merge.', 'baseline');
      if (!await s.git.optional(['rev-parse', '--verify', `${baseline}^{commit}`])) throw new SyncError('The shared baseline is unavailable. Restore its Git history before syncing.', 'baseline');
      const saved = await readSaved(s.git.root, s.paths, true), proposed: SavedTexts = { ...saved }, files: IncomingFile[] = [];
      for (const doc of inspection.docs) {
        let base = '';
        if (await s.git.optional(['rev-parse', '--verify', `${baseline}:${doc.path}`])) base = await s.git.text(baseline, doc.path);
        const before = saved[doc.path] ?? '';
        const merge = saved[doc.path] === null ? { text: doc.text, conflict: false } : await mergeSaved(base, before, doc.text);
        proposed[doc.path] = merge.text;
        if (saved[doc.path] === null || before !== merge.text || merge.conflict) files.push({ path: doc.path, before, after: merge.text, base, remote: doc.text, conflict: merge.conflict, ...changedLines(diffText(before, merge.text).diffs) });
      }
      return { head, sourceBranch, snapshot, baseline, inspection, cache, saved, proposed, files };
    });
  }
  resolve(plan: PullPlan, path: string, text: string): PullPlan {
    if (!plan.files.some(file => file.path === path && file.conflict)) throw new SyncError('This file has no pending conflict.', 'configuration');
    if (/^(<{7}|\|{7}|={7}|>{7})(?: |$)/m.test(text)) throw new SyncError('Remove all merge conflict markers before using the resolution.', 'conflict');
    validateUpload(path, Buffer.from(text));
    return { ...plan, proposed: { ...plan.proposed, [path]: text }, files: plan.files.map(file => file.path === path ? { ...file, after: text, conflict: false, ...changedLines(diffText(file.before, text).diffs) } : file) };
  }
  async apply(plan: PullPlan, valid: () => boolean): Promise<{ snapshot: string; checkpoint: string }> {
    const s = this.sync;
    return s.git.exclusive(async () => {
      await s.git.init();
      if (plan.files.some(file => file.conflict)) throw new SyncError('Resolve every conflict and review the result before applying.', 'conflict');
      if ((await s.state.cache()).localApply) throw new SyncError('Recover the interrupted local apply first.', 'recovery');
      const checkLocal = async () => {
        if (!valid() || await s.state.claimSnapshot() !== plan.sourceBranch || await s.git.head() !== plan.head || await s.git.snapshot() !== plan.snapshot || !sameSaved(await readSaved(s.git.root, s.paths, true), plan.saved)) throw new SyncError('Local contents or Git changed. Get latest again.', 'stale');
      };
      await checkLocal();
      const fresh = await s.fetchPull();
      if (!sameRemote(plan.inspection, fresh, plan.cache)) throw new SyncError('Overleaf changed during review. Get latest again.', 'stale');
      await checkLocal(); checkCancelled();
      const checkpoint = await s.git.checkpoint(plan.saved, 'before apply');
      await s.state.updateCache(cache => { cache.localApply = { checkpoint, before: plan.saved, after: plan.proposed }; });
      try {
        for (const file of plan.files) {
          checkCancelled();
          await replaceSaved(s.git.root, file.path, plan.saved[file.path], plan.proposed[file.path], valid);
        }
        if (!valid() || !sameSaved(await readSaved(s.git.root, s.paths, true), plan.proposed) || await s.git.head() !== plan.head || await s.state.claimSnapshot() !== plan.sourceBranch || await s.git.snapshot() !== plan.snapshot) throw new SyncError('Files or workspace changed during apply.', 'stale');
        const snapshot = await s.git.record(remoteTexts(fresh), plan.baseline, undefined, false, plan.snapshot ?? null);
        await s.saveRefresh(fresh);
        await s.state.updateCache(cache => { cache.appliedSnapshot = snapshot; delete cache.localApply; delete cache.partialPush; delete cache.reconciliation; });
        return { snapshot, checkpoint };
      } catch (error) {
        throw new SyncError(`${error instanceof Error ? error.message : error}\nLocal recovery checkpoint: ${checkpoint}. Run Recover Local Apply before continuing.`, 'recovery');
      }
    });
  }
  async recover(valid: () => boolean): Promise<string> {
    const s = this.sync;
    return s.git.exclusive(async () => {
      await s.state.claimSnapshot();
      const journal = (await s.state.cache()).localApply;
      if (!journal) throw new SyncError('No interrupted local apply needs recovery.', 'recovery');
      if (Object.keys(journal.before).sort().join('\0') !== [...s.paths].sort().join('\0') || Object.keys(journal.after).sort().join('\0') !== [...s.paths].sort().join('\0')) throw new SyncError('Recovery journal does not match this file selection.', 'recovery');
      const current = await readSaved(s.git.root, s.paths, true);
      for (const path of s.paths) if (current[path] !== journal.before[path] && current[path] !== journal.after[path]) throw new SyncError(`${path} changed after the interrupted apply. Preserve those edits and compare checkpoint ${journal.checkpoint} before recovery.`, 'recovery');
      for (const path of s.paths) if (current[path] !== journal.before[path]) await replaceSaved(s.git.root, path, current[path], journal.before[path], valid);
      await s.state.updateCache(cache => { delete cache.localApply; });
      return journal.checkpoint;
    });
  }
}
