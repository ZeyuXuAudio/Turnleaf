import { readFile } from 'node:fs/promises';
import { Inspection, DocState } from './models';
import { GitStore } from './git';
import { LocalState, Cache, workspacePath } from './storage';
import { OverleafReader, RemoteSession } from './overleaf';
import { guardedWrite, validateUpload } from './guard';
import { mapDocument, Mapping } from './ranges';
import { diffText, changedLines } from './diff';
import { reviewRows, rememberAnchors, trackedInspection } from './review';
import { SyncError } from './errors';
import { progress } from './operation';
import { SavedTexts, readSaved, sameSaved } from './savedFiles';

export const remoteTexts = (i: Inspection) => Object.fromEntries(i.docs.map(d => [d.path, d.text]));
function canonical(value: any): string {
  return JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
}
export function reviewFingerprint(inspection: Inspection, cache: Cache): string {
  const i = trackedInspection(inspection, cache), ids = new Set(i.docs.flatMap(d => d.comments.map(c => c.threadId)));
  return canonical({ docs: [...i.docs].sort((a, b) => a.path.localeCompare(b.path)).map(d => ({ path: d.path, docId: d.docId, folderId: d.folderId, type: d.otType, comments: [...d.comments].sort((a, b) => a.threadId.localeCompare(b.threadId)), changes: d.changes.map(({ id, ...c }) => c), rawChanges: d.rawChanges })), threads: Object.fromEntries(Object.entries(i.threads).filter(([id]) => ids.has(id))) });
}
export interface PushFile { doc: DocState; bytes: Buffer; text: string; mapping: Mapping; added: number; removed: number; }
export interface PushPlan { head: string; sourceBranch: string; snapshot: string; inspection: Inspection; files: PushFile[]; cache: Cache; saved?: SavedTexts; }
export interface PushResult { inspection: Inspection; snapshot: string; mismatches: string[]; warnings: string[]; updates: RemoteSession['socket']['updates']; }
export class SyncService {
  constructor(readonly git: GitStore, readonly state: LocalState, private readonly reader: OverleafReader | (() => Promise<OverleafReader>), readonly projectId: string, readonly paths: string[]) {}
  async remote(): Promise<OverleafReader> { return typeof this.reader === 'function' ? this.reader() : this.reader; }
  async localTexts(): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const path of this.paths) {
      try { result[path] = await readFile(await workspacePath(this.git.root, path), 'utf8'); }
      catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    }
    return result;
  }
  private complete(i: Inspection): void { if (i.missingFiles.length) throw new SyncError(`Tracked files missing on Overleaf: ${i.missingFiles.join(', ')}. Nothing was created or uploaded.`, 'missing'); }
  async saveRefresh(i: Inspection): Promise<Cache> {
    const texts = await this.localTexts();
    return this.state.updateCache(cache => {
      rememberAnchors(cache, reviewRows(i, cache, texts));
      cache.inspection = i;
    });
  }
  async refresh(): Promise<Inspection> { const i = await (await this.remote()).inspect(this.projectId, this.paths); await this.saveRefresh(i); return i; }
  async fetchPull(): Promise<Inspection> { await this.git.init(); const i = await (await this.remote()).inspect(this.projectId, this.paths); this.complete(i); return i; }
  async verifySnapshotLink(): Promise<void> {
    const fresh = await this.fetchPull();
    await this.state.claimSnapshot(remoteTexts(fresh));
  }
  async recordPull(i: Inspection, baseline?: string): Promise<string> {
    return this.git.exclusive(async () => {
      await this.git.init(); await this.state.claimSnapshot();
      const old = await this.git.snapshot();
      if (old) await this.git.assertSnapshotScope(old, this.paths);
      const snapshot = await this.git.record(remoteTexts(i), baseline);
      await this.saveRefresh(i); await this.state.updateCache(cache => { delete cache.partialPush; delete cache.reconciliation; });
      return snapshot;
    });
  }
  async mergePull(snapshot: string, stash: boolean, expectedHead: string, expectedBranch: string): Promise<void> {
    await this.git.exclusive(async () => {
      const branch = await this.state.claimSnapshot();
      if (branch !== expectedBranch || await this.git.head() !== expectedHead || await this.git.snapshot() !== snapshot) throw new SyncError('Git changed while reviewing the pull. Run Pull again.', 'git');
      await this.git.merge(snapshot, stash, false, this.paths, branch);
    });
  }
  async reconciliation(i: Inspection): Promise<void> { await this.saveRefresh(i); await this.state.updateCache(cache => { cache.reconciliation = i; }); }
  async markReconciled(): Promise<{ changed?: Inspection; snapshot?: string }> {
    return this.git.exclusive(async () => {
      await this.git.init(); await this.git.requireClean();
      const cache = await this.state.cache();
      if (!cache.reconciliation) throw new SyncError('Start Pull and choose Reconcile by hand first.', 'git');
      if (await this.git.snapshot()) throw new SyncError('A snapshot already exists. Use Pull to merge it.', 'git');
      const fresh = await this.fetchPull();
      if (canonical(remoteTexts(fresh)) !== canonical(remoteTexts(cache.reconciliation))) { await this.reconciliation(fresh); return { changed: fresh }; }
      const sourceBranch = await this.state.claimSnapshot();
      const snapshot = await this.git.record(remoteTexts(fresh), await this.git.head());
      await this.git.merge(snapshot, false, true, this.paths, sourceBranch);
      await this.saveRefresh(fresh); await this.state.updateCache(cache => { delete cache.reconciliation; });
      return { snapshot };
    });
  }
  async preflight(): Promise<PushPlan> {
    return this.git.exclusive(async () => {
      await this.git.init(); await this.git.requireClean();
      const sourceBranch = await this.state.claimSnapshot();
      const cache = await this.state.cache(), snapshot = await this.git.snapshot(), head = await this.git.head();
      if (cache.partialPush) throw new SyncError(`Previous push stopped after: ${cache.partialPush.join(', ') || 'no confirmed uploads'}. Run Pull before pushing again.`, 'push');
      if (!snapshot || !await this.git.merged(this.paths)) throw new SyncError('Run Pull and merge the Overleaf snapshot before pushing.', 'push');
      await this.git.assertSnapshotScope(snapshot, this.paths);
      if (!cache.inspection) throw new SyncError('Run Refresh Comments before pushing.', 'push');
      const i = await (await this.remote()).inspect(this.projectId, this.paths);
      this.complete(i);
      if (!await this.git.matches(snapshot, remoteTexts(i))) throw new SyncError('Overleaf changed since your last pull: run Pull.', 'push');
      if (reviewFingerprint(i, cache) !== reviewFingerprint(cache.inspection, cache)) throw new SyncError('Comments or suggestions changed on Overleaf: run Refresh Comments.', 'push');
      const files: PushFile[] = [];
      for (const doc of trackedInspection(i, cache).docs) {
        progress(`Checking committed file ${doc.path}…`);
        const bytes = await this.git.bytes(head, doc.path);
        if (bytes.equals(Buffer.from(doc.text))) continue;
        const text = validateUpload(doc.path, bytes), diff = diffText(doc.text, text);
        const mapping = mapDocument(doc, text, i.trackChanges, diff.diffs); mapping.slow = diff.slow;
        files.push({ doc, bytes, text, mapping, ...changedLines(diff.diffs) });
      }
      return { head, sourceBranch, snapshot, inspection: i, files, cache };
    });
  }
  async push(plan: PushPlan, allow: () => boolean, output: (line: string) => void): Promise<PushResult> {
    return this.git.exclusive(async () => {
      const uploaded: string[] = [], warnings: string[] = [];
      const reader = await this.remote();
      let session: RemoteSession | undefined;
      let attempted = false;
      try {
        const checkSaved = async () => {
          if (!allow()) throw new SyncError('Sending was disabled or an editor changed. Review again.', 'stale');
          if (plan.saved) {
            if (!sameSaved(await readSaved(this.git.root, this.paths), plan.saved)) throw new SyncError('Saved files changed during review. Review again.', 'stale');
          } else await this.git.requireClean();
        };
        await checkSaved();
        if ((await this.state.cache()).localApply) throw new SyncError('Recover the interrupted local apply first.', 'recovery');
        if (await this.state.claimSnapshot() !== plan.sourceBranch) throw new SyncError('The author branch changed. Run Push again.', 'push');
        if (await this.git.head() !== plan.head || await this.git.snapshot() !== plan.snapshot) throw new SyncError('Git changed while confirming. Run Push again.', 'push');
        // The review dialog may remain open indefinitely. Start a new monitored
        // session now, then bind all checks and uploads to that session.
        session = await reader.openSession(this.projectId, this.paths);
        const afterDialog = session.inspection;
        this.complete(afterDialog);
        if (canonical(remoteTexts(afterDialog)) !== canonical(remoteTexts(plan.inspection)) || afterDialog.docs.some(d => d.version !== plan.inspection.docs.find(p => p.path === d.path)?.version) || reviewFingerprint(afterDialog, plan.cache) !== reviewFingerprint(plan.inspection, plan.cache) || afterDialog.trackChanges !== plan.inspection.trackChanges || afterDialog.userId !== plan.inspection.userId) throw new SyncError('Overleaf changed while confirming. Pull or Refresh, then review a new push.', 'push');
        await checkSaved();
        if (plan.saved && plan.files.length) output(`Saved-file checkpoint: ${await this.git.checkpoint(plan.saved, 'before send')}`);
        for (const file of plan.files) {
          progress(`Uploading ${file.doc.path} (${uploaded.length + 1}/${plan.files.length})…`);
          await this.state.claimSnapshot();
          await checkSaved();
          if (await this.git.head() !== plan.head || await this.git.snapshot() !== plan.snapshot) throw new SyncError('Git changed during the push. Run Pull.', 'push');
          const checked = await session.rejoin(file.doc);
          if (checked.version !== file.doc.version || checked.text !== file.doc.text) throw new SyncError(`Overleaf changed during the push (${file.doc.path}). Run Pull.`, 'push');
          await guardedWrite(this.state, { kind: 'upload', projectId: this.projectId, path: file.doc.path, folderId: file.doc.folderId, docId: file.doc.docId, bytes: file.bytes }, allow, async () => true, async permit => {
            // Persist recovery state before a request can reach the server, including crashes.
            await this.state.updateCache(cache => { cache.partialPush = [...uploaded]; });
            attempted = true; await reader.write(permit);
          }, output);
          uploaded.push(file.doc.path);
          if (!await session.socket.waitForUpload(file.doc.docId, checked.version, afterDialog.userId)) warnings.push(`${file.doc.path}: upload event was not observed within 2 seconds; read-back verification is required. Check Overleaf history for concurrent changes.`);
          const observed = await session.rejoin(file.doc);
          const events = session.socket.updates.filter(e => e.doc === file.doc.docId && e.v >= checked.version);
          const own = events.find(e => e.meta?.type === 'external' && e.meta?.source === 'upload' && e.meta?.user_id === plan.inspection.userId);
          for (const event of events.filter(e => e !== own)) warnings.push(`${file.doc.path}: ${own && event.v < own.v ? 'overwritten concurrent edit; recover from Overleaf history' : 'concurrent edit detected'} (version ${event.v}, author ${event.meta?.user_id ?? 'unknown'}, time ${event.meta?.ts ?? 'unknown'}).`);
          if (observed.version > checked.version + 1) warnings.push(`${file.doc.path}: unexpected version jump; a concurrent edit may have been overwritten. Check Overleaf history.`);
          if (session.socket.updateError) throw new SyncError('Socket reported an update error; the upload outcome needs verification.', 'push');
        }
        const i = await reader.inspect(this.projectId, this.paths); this.complete(i);
        const mismatches: string[] = [];
        for (const doc of i.docs) if (!(plan.saved ? Buffer.from(plan.saved[doc.path]!) : await this.git.bytes(plan.head, doc.path)).equals(Buffer.from(doc.text))) mismatches.push(doc.path);
        await this.state.claimSnapshot();
        if (await this.git.head() !== plan.head) throw new SyncError('Git changed during verification. Run Pull.', 'push');
        const snapshot = await this.git.record(remoteTexts(i), undefined, mismatches.length || plan.saved ? undefined : plan.head, true, plan.snapshot);
        await this.saveRefresh(i);
        await this.state.updateCache(cache => { if (plan.saved && !mismatches.length) cache.appliedSnapshot = snapshot; if (plan.saved && mismatches.length) cache.partialPush = uploaded; else delete cache.partialPush; });
        return { inspection: i, snapshot, mismatches, warnings, updates: [...session.socket.updates] };
      } catch (error) {
        if (!attempted && error instanceof SyncError && ['cancelled', 'session-expired'].includes(error.code)) throw error;
        if (attempted) {
          await this.state.updateCache(cache => { cache.partialPush = uploaded; });
          // Read back for recovery, but do not bless a partial/ambiguous push as synchronized.
          try { const actual = await reader.inspect(this.projectId, this.paths); output(`Recovery read: ${actual.docs.map(d => `${d.path} v${d.version}`).join(', ')}.`); } catch { output('Recovery read failed; upload outcome is unknown.'); }
        }
        throw new SyncError(`${error instanceof Error ? error.message : error}\nConfirmed uploads: ${uploaded.join(', ') || 'none'}. Not confirmed: ${plan.files.filter(f => !uploaded.includes(f.doc.path)).map(f => f.doc.path).join(', ') || 'none'}.${attempted ? ' Run Pull before pushing again.' : ''}`, 'push', undefined, error);
      } finally { await session?.close(); }
    });
  }
}

export function pushReport(plan: PushPlan, writes: boolean): string {
  const i = plan.inspection;
  const lines = ['# Overleaf push review', '', `Project: ${i.projectName}`, plan.saved ? `Source: reviewed saved files (author HEAD ${plan.head})` : `Commit: ${plan.head}`, `Writes: ${writes ? 'enabled' : 'disabled (dry run still works)'}`, `Track Changes: ${i.trackChanges === undefined ? 'unknown; enable it in Overleaf if reviewers should see tracked edits' : i.trackChanges ? 'on for you' : 'off for you; enable it in Overleaf if reviewers should see tracked edits'}`, '', 'Predictions are approximate. A simultaneous edit in the last check/upload window can be overwritten and remains in Overleaf history.', ''];
  for (const f of plan.files) {
    lines.push(`## ${f.doc.path}`, '', `+${f.added} / −${f.removed} changed lines · ${f.bytes.length} bytes · ${i.trackChanges === undefined ? 'tracked edit count unknown' : `${f.mapping.trackedEdits} predicted tracked edit operations`}`, '');
    for (const c of f.mapping.comments.filter(c => ['edited locally', 'deleted locally'].includes(c.label))) {
      const m = i.threads[c.threadId]?.messages[0];
      lines.push(`- ${c.threadId}: ${c.state === 'hidden' ? 'hidden in a suggested deletion' : c.label} — ${m?.author ?? ''}: ${m?.text ?? ''}`);
    }
    for (const s of f.mapping.affectedSuggestions) lines.push(`- Suggestion by ${s.suggestion.author}: ${s.effect} (${s.suggestion.text})`);
    if (f.mapping.slow) lines.push('Large/slow diff: the server may split edits differently. Prefer smaller pushes.');
    lines.push('');
  }
  if (!plan.files.length) lines.push('No files need uploading.');
  if (i.trackChanges === undefined) lines.push('', 'Track Changes state is unavailable: anchor predictions assume it is off. With it on, a history-ot anchor may become hidden inside a suggested deletion instead of being removed. Verification reports the actual result.');
  return lines.join('\n');
}
