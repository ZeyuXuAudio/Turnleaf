import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile, access, cp } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Inspection, Thread } from './models';
import type { Cache, KnownAnchor, Reviews, ReviewState } from './storage';
import { atomicJson, workspacePath } from './storage';
import { withSyncLock } from './lock';
import { SyncError } from './errors';
import type { SavedTexts } from './savedFiles';
import type { WriteAction } from './guard';
import { Decision, SuggestionRef, sameSuggestion } from './suggestions';
import { PictureState, emptyPictures, gitBlobSha1, isPicture, validHash } from './pictures';
import { diffText } from './diff';
import { mapPoint } from './ranges';

export type CommentKind = Exclude<WriteAction['kind'], 'upload' | 'uploadFile' | 'deleteFile' | 'edit' | 'createFolder' | 'createDoc' | 'deleteDoc'>;
// Drafts wait for Send. 'acceptChange' and 'rejectChange' decide the
// suggestion `change` and have no thread (`threadId` is empty).
export interface CommentDraft {
  id: string; kind: CommentKind; path: string; docId: string; threadId: string; messageId?: string; text?: string;
  before?: Thread; anchor?: { from: number; to: number; source: string }; created: string; uncertain?: boolean;
  change?: SuggestionRef;
}
export const isDecision = (draft: CommentDraft) => draft.kind === 'acceptChange' || draft.kind === 'rejectChange';
/**
 * A new comment's selection in the saved `text`: the selected text followed through
 * the edits since it was selected, or else its only occurrence. Undefined when the
 * selected text itself changed or cannot be told apart, so it must be selected again.
 */
export function moveSelection(anchor: NonNullable<CommentDraft['anchor']>, text: string): CommentDraft['anchor'] {
  if (anchor.source === text) return anchor;
  const quoted = anchor.source.slice(anchor.from, anchor.to);
  if (!quoted) return;
  const from = mapPoint(anchor.from, diffText(anchor.source, text).diffs);
  if (text.slice(from, from + quoted.length) === quoted) return { from, to: from + quoted.length, source: text };
  // Moved elsewhere, e.g. a paragraph cut and pasted: only a text unique before and after.
  const once = (value: string) => { const at = value.indexOf(quoted); return at >= 0 && value.indexOf(quoted, at + 1) < 0 ? at : -1; };
  const first = once(text);
  if (first >= 0 && once(anchor.source) >= 0) return { from: first, to: first + quoted.length, source: text };
}
/** New comments whose saved file differs from their selection's copy of it. */
const outdated = (data: ProjectData, saved: SavedTexts) => data.pending.filter(draft => draft.kind === 'createThread' && draft.anchor && typeof saved[draft.path] === 'string' && draft.anchor.source !== saved[draft.path]);
/** The step name recorded for a draft in sync history and interrupted-send fences. */
export const draftStep = (draft: CommentDraft) => `${isDecision(draft) ? 'suggestion' : 'comment'}:${draft.id}`;
/** `line`: where the commented text starts in the file, 1-based. */
export interface CommentChange { id: string; path: string; label: string; threadId?: string; line?: number; before?: Thread; after?: Thread; anchorChanged?: boolean; anchorText?: string; anchorBefore?: string; draftId?: string;
  suggestion?: { decision: Decision; kind: 'insert' | 'delete'; text: string; author: string; line: number }; }
/** 'full' reads every selected file before and after Send; 'fast' re-reads only the files
 * the live connection reported as edited and the files the Send wrote. */
export type SendCheck = 'full' | 'fast';
export interface SyncHistory {
  id: string; time: string; finished?: string; direction: 'send' | 'pull'; project: string;
  outcome: 'started' | 'success' | 'stale' | 'failed' | 'partial' | 'uncertain' | 'recovered';
  files: { path: string; before: string; after: string }[]; comments: CommentChange[];
  completed: string[]; warnings: string[]; error?: string; checkpoint?: string;
  /**
   * Get latest records: the pictures this Apply wrote, acknowledged or stopped
   * tracking, by hash and size. An overwritten local copy (`before`) is kept as
   * `history/blobs/<hash>.bin` while this record is kept. Send records: the
   * pictures it replaced, created, put back or deleted on Overleaf; `before` is
   * Overleaf's copy that was replaced, kept the same way for Undo this send.
   */
  pictures?: { path: string; kind: string; before: { hash: string; size: number } | null; after: { hash: string; size: number } | null }[];
  // Send records only: how Overleaf was read around the writes (see SyncService.sendCheck).
  check?: { mode: SendCheck; note?: string };
  observed?: { time: string; files: Record<string, string>; comments: Record<string, Thread> };
  // Send records only. What Undo this send needs beyond the file texts: whether
  // Track Changes was on, the suggestions each edit created, how many comments
  // and suggestions the edit replaced, and the message each comment change made.
  // Pictures: `sent.files[path]` holds the hash the Send replaced (kept as
  // history/blobs/<hash>.bin, also listed in `pictures`), the hash it wrote and the new file ID.
  sent?: { trackChanges?: boolean;
    files: Record<string, SentText | SentPicture>;
    comments: Record<string, { kind: CommentKind; threadId: string; docId: string; messageId?: string }>;
    // Files this Send created on Overleaf, with the folders it created for them (parents first):
    // a text document by `docId`, a picture by `fileId`.
    created?: Record<string, { docId?: string; fileId?: string; folders: { path: string; id: string }[] }> };
  /** This record is the undo of that Send record. */
  undoOf?: string;
  /** This Send was taken back by that undo record. */
  undoneBy?: string;
}
export interface SentText { suggestions: SuggestionRef[]; lostComments: number; lostSuggestions: number; }
export interface SentPicture { replacedHash?: string; sentHash: string; fileId: string; }
export const isSentPicture = (entry: SentText | SentPicture | undefined): entry is SentPicture => !!entry && 'sentHash' in entry;
export interface ProjectData {
  schema: 2; revision?: string; acknowledged?: Inspection; observed?: Inspection;
  anchors: Record<string, KnownAnchor>; reviews: Reviews; pending: CommentDraft[];
  // pictures: each picture Apply writes, by the hash it had (null: absent) and the one it gets.
  localApply?: { history: string; before: SavedTexts; after: SavedTexts; pictures?: Record<string, { before: string | null; after: string }> };
  partialSend?: { history: string; confirmed: string[]; uncertain: string[] };
  // Last accepted JSON files and their corresponding drafts. Updated in the
  // same transaction as imports, so a restart cannot queue an edit twice.
  reviewFiles?: { schema: 1; records: Record<string, { content: string; drafts: CommentDraft[] }> };
}
// Stored history keeps file texts as content-hash references; older records hold plain strings.
type StoredText = string | { blob: string };
type StoredHistory = Omit<SyncHistory, 'files' | 'observed'> & { files: { path: string; before: StoredText; after: StoredText }[];
  observed?: Omit<NonNullable<SyncHistory['observed']>, 'files'> & { files: Record<string, StoredText> } };
const empty = (): ProjectData => ({ schema: 2, anchors: {}, reviews: {}, pending: [] });

/**
 * When the file selection only grows, the new selection keeps the sync state of
 * the old one (baseline, queued comment changes, history, review files): the
 * old partition is copied and left as it was. The added files have no baseline
 * yet. Refused while the old selection has an interrupted sync.
 *
 * The new selection may already have a state from an earlier use. It is kept
 * when its last sync is newer than the old selection's ('none'); otherwise it
 * is moved aside to `<key>.replaced-<time>` and replaced, so a queued comment
 * change that was sent meanwhile from the old selection cannot go out again.
 * The copy is written to a temporary sibling and renamed into place, so an
 * interrupted copy is never taken for a complete state.
 */
export async function carrySelection(root: string, baseUrl: string, projectId: string, from: string[], to: string[]): Promise<'copied' | 'none'> {
  const added = to.filter(path => !from.includes(path));
  if (!from.length || !added.length || from.some(path => !to.includes(path))) return 'none';
  const old = new ProjectStore(root, baseUrl, projectId, from), next = new ProjectStore(root, baseUrl, projectId, to);
  return old.exclusive(async () => {
    const source = dirname(await old.path('state.json')), target = dirname(await next.path('state.json'));
    try { await access(await old.path('state.json')); } catch { return 'none'; }
    const data = await old.read();
    if (data.localApply || data.partialSend) throw new SyncError('Finish the interrupted sync (Recover local apply or Get latest) before adding files to the selection.', 'recovery');
    const present = await access(target).then(() => true, () => false);
    if (present && await next.lastSync() > await old.lastSync()) return 'none';
    const stamp = Date.now(), partial = `${target}.partial-${stamp}`;
    try { await cp(source, partial, { recursive: true, errorOnExist: true, force: false }); }
    catch (error) { await rm(partial, { recursive: true, force: true }); throw error; }
    if (present) await rename(target, `${target}.replaced-${stamp}`);
    await rename(partial, target);
    return 'copied';
  });
}

/** Persisted folder state. It neither reads nor writes Git metadata. */
export class ProjectStore {
  readonly key: string;
  /** The project's own key, independent of the file selection: picture state lives under it. */
  readonly projectKey: string;
  constructor(readonly root: string, readonly baseUrl: string, readonly projectId: string, readonly paths: string[]) {
    this.key = createHash('sha256').update(JSON.stringify([baseUrl, projectId, [...paths].sort()])).digest('hex');
    this.projectKey = createHash('sha256').update(JSON.stringify(['project', baseUrl, projectId])).digest('hex');
  }
  /** Whether pictures and PDF figures take part (`turnleaf.syncPictures`). */
  syncPictures: () => boolean = () => true;
  /** A file of the project's picture state, outside the selection key. */
  async picturePath(file: string): Promise<string> { return workspacePath(this.root, `.turnleaf/projects/${this.projectKey}/${file}`); }
  async pictures(): Promise<PictureState> {
    let value: PictureState;
    try { value = JSON.parse(await readFile(await this.picturePath('pictures.json'), 'utf8')); }
    catch (error: any) { if (error.code === 'ENOENT') return emptyPictures(); throw new SyncError('Cannot read the local picture state. Preserve the file and restore valid JSON before continuing.', 'cache'); }
    if (value?.schema !== 1 || !value.baseline || typeof value.baseline !== 'object' || Object.values(value.baseline).some(entry => !validHash(entry?.hash) || entry.size !== undefined && !Number.isSafeInteger(entry.size))
      || value.added !== undefined && (!Array.isArray(value.added) || value.added.some(path => typeof path !== 'string' || !isPicture(path)))) throw new SyncError('Unsupported local picture state. Preserve it before continuing.', 'cache');
    return value;
  }
  async setPictures(next: PictureState): Promise<void> { await this.exclusive(async () => atomicJson(await this.picturePath('pictures.json'), next)); }
  async path(file: string): Promise<string> { return workspacePath(this.root, `.turnleaf/projects/${this.key}/${file}`); }
  async init(): Promise<void> { await mkdir(await workspacePath(this.root, '.turnleaf'), { recursive: true, mode: 0o700 }); }
  async exclusive<T>(action: () => Promise<T>): Promise<T> {
    await this.init(); return withSyncLock(await workspacePath(this.root, '.turnleaf'), action);
  }
  async read(): Promise<ProjectData> {
    let value: ProjectData;
    try { value = JSON.parse(await readFile(await this.path('state.json'), 'utf8')); }
    catch (error: any) { if (error.code === 'ENOENT') return empty(); throw new SyncError('Cannot read local sync state. Preserve the state file and restore valid JSON before continuing.', 'cache'); }
    if (value.schema !== 2 || !value.anchors || !value.reviews || !Array.isArray(value.pending)) throw new SyncError('Unsupported local sync state. Preserve it before reconnecting.', 'cache');
    return value;
  }
  async update(change: (data: ProjectData) => void | Promise<void>): Promise<ProjectData> {
    return this.exclusive(async () => { const data = await this.read(); await change(data); await atomicJson(await this.path('state.json'), data); return data; });
  }
  async cache(): Promise<Cache> {
    const data = await this.read();
    return { schema: 1, anchors: data.anchors, inspection: data.acknowledged, appliedSnapshot: data.revision,
      partialPush: data.partialSend && data.partialSend.confirmed,
      localApply: data.localApply && { checkpoint: data.localApply.history, before: data.localApply.before, after: data.localApply.after } };
  }
  async reviews(): Promise<Reviews> { return (await this.read()).reviews; }
  async setReview(id: string, value: ReviewState): Promise<void> { await this.update(data => { data.reviews[id] = value; }); }
  async queue(draft: CommentDraft): Promise<void> {
    if (!this.paths.includes(draft.path) || !draft.docId || (isDecision(draft) ? !draft.change : !draft.threadId)) throw new SyncError('Select a linked source file for this draft.', 'configuration');
    if (['reply', 'editMessage', 'createThread'].includes(draft.kind) && (!draft.text?.trim() || draft.text.length > 20_000)) throw new SyncError('Enter comment text between 1 and 20,000 characters.', 'configuration');
    await this.update(data => {
      if (data.localApply || data.partialSend) throw new SyncError('Review the interrupted sync before changing pending comments.', 'recovery');
      // Only explicitly editing the same draft replaces its content. Distinct
      // replies stay distinct and are sent in the reviewed order.
      if (draft.kind === 'deleteThread') data.pending = data.pending.filter(item => item.threadId !== draft.threadId);
      // One decision per suggestion: the newest replaces an earlier one.
      if (isDecision(draft)) data.pending = data.pending.filter(item => item.id === draft.id || !isDecision(item) || item.docId !== draft.docId || !sameSuggestion(item.change!, draft.change!));
      const index = data.pending.findIndex(item => item.id === draft.id);
      if (index < 0) data.pending.push(draft); else data.pending[index] = draft;
    });
  }
  /**
   * Moves new comments with their selected text after their file was saved with
   * edits. Returns the ones moved, and those that need a new selection (their text
   * changed, occurs more than once, or the draft cannot change now).
   */
  async followSelections(saved: SavedTexts): Promise<{ moved: string[]; unplaced: string[] }> {
    const result = { moved: [] as string[], unplaced: [] as string[] };
    if (!outdated(await this.read(), saved).length) return result;
    return this.exclusive(async () => {
      const data = await this.read(), stale = outdated(data, saved);
      const frozen = !!(data.localApply || data.partialSend), next = new Map<string, CommentDraft>();
      for (const draft of stale) {
        const anchor = frozen || draft.uncertain ? undefined : moveSelection(draft.anchor!, saved[draft.path]!);
        if (anchor) { next.set(draft.id, { ...draft, anchor }); result.moved.push(draft.id); } else result.unplaced.push(draft.id);
      }
      if (next.size) await this.update(current => { current.pending = current.pending.map(draft => next.get(draft.id) ?? draft); });
      return result;
    });
  }
  async discard(id: string): Promise<void> { await this.update(data => {
    if (data.localApply || data.partialSend) throw new SyncError('Review the interrupted sync before discarding drafts.', 'recovery');
    const parent = data.pending.find(draft => draft.id === id && draft.kind === 'createThread');
    data.pending = data.pending.filter(draft => draft.id !== id && (!parent || draft.threadId !== parent.threadId));
  }); }
  /** Retention for finished history records; 0 disables a limit. */
  retention: () => { records: number; days: number } = () => ({ records: 50, days: 90 });
  // Each distinct file text is stored once under history/blobs, by content hash.
  private async putText(text: string): Promise<{ blob: string }> {
    const blob = createHash('sha256').update(text).digest('hex'), path = await this.path(`history/blobs/${blob}.txt`);
    try { await access(path); }
    catch {
      await mkdir(dirname(path), { recursive: true });
      const temp = `${path}.${randomUUID()}.tmp`;
      await writeFile(temp, text, { mode: 0o600 }); await rename(temp, path);
    }
    return { blob };
  }
  /** Keeps picture bytes in Sync history once, as `history/blobs/<git blob sha1>.bin`; returns the hash. */
  async putBytes(bytes: Buffer): Promise<string> {
    const blob = gitBlobSha1(bytes), path = await this.path(`history/blobs/${blob}.bin`);
    try { await access(path); }
    catch {
      await mkdir(dirname(path), { recursive: true });
      const temp = `${path}.${randomUUID()}.tmp`;
      await writeFile(temp, bytes, { mode: 0o600 }); await rename(temp, path);
    }
    return blob;
  }
  /** Picture bytes kept in Sync history, or undefined once pruned. They must still hash to `hash`. */
  async getBytes(hash: string): Promise<Buffer | undefined> {
    if (!validHash(hash)) throw new SyncError('Invalid history record.', 'cache');
    let bytes: Buffer;
    try { bytes = await readFile(await this.path(`history/blobs/${hash}.bin`)); }
    catch (error: any) { if (error.code === 'ENOENT') return undefined; throw error; }
    if (gitBlobSha1(bytes) !== hash) throw new SyncError('A picture kept in Sync history is damaged.', 'cache');
    return bytes;
  }
  private async getText(value: StoredText): Promise<string> {
    if (typeof value === 'string') return value;
    if (!/^[0-9a-f]{64}$/.test(value?.blob)) throw new SyncError('Invalid history record.', 'cache');
    return readFile(await this.path(`history/blobs/${value.blob}.txt`), 'utf8');
  }
  async writeHistory(entry: SyncHistory): Promise<void> {
    if (!/^[\w-]+$/.test(entry.id)) throw new SyncError('Invalid history record.', 'cache');
    await this.exclusive(async () => {
      const stored: StoredHistory = { ...entry,
        files: await Promise.all(entry.files.map(async file => ({ path: file.path, before: await this.putText(file.before), after: await this.putText(file.after) }))),
        observed: entry.observed && { ...entry.observed, files: Object.fromEntries(await Promise.all(Object.entries(entry.observed.files).map(async ([path, text]) => [path, await this.putText(text)]))) } };
      await atomicJson(await this.path(`history/${entry.id}.json`), stored);
      if (entry.outcome !== 'started') await this.pruneHistory();
    });
  }
  /** The time of the newest sync record (Get latest, Send, Undo), 0 without one. */
  async lastSync(): Promise<number> {
    return Math.max(0, ...(await this.records()).map(entry => new Date(entry.finished ?? entry.time).getTime()));
  }
  private async records(): Promise<StoredHistory[]> {
    let names: string[];
    try { names = await readdir(await this.path('history')); }
    catch (error: any) { if (error.code === 'ENOENT') return []; throw error; }
    const entries: StoredHistory[] = [];
    for (const name of names.filter(name => /^[\w-]+\.json$/.test(name))) {
      const entry = JSON.parse(await readFile(await this.path(`history/${name}`), 'utf8')) as StoredHistory;
      if (entry.id && entry.direction && Array.isArray(entry.files) && Array.isArray(entry.comments)) entries.push(entry);
    }
    return entries.sort((a, b) => b.time.localeCompare(a.time));
  }
  async history(id?: string): Promise<SyncHistory[]> {
    if (id && !/^[\w-]+$/.test(id)) throw new SyncError('Invalid history selection.', 'cache');
    const entries = (await this.records()).filter(entry => !id || entry.id === id);
    return Promise.all(entries.map(async entry => ({ ...entry,
      files: await Promise.all(entry.files.map(async file => ({ path: file.path, before: await this.getText(file.before), after: await this.getText(file.after) }))),
      observed: entry.observed && { ...entry.observed, files: Object.fromEntries(await Promise.all(Object.entries(entry.observed.files).map(async ([path, text]) => [path, await this.getText(text)]))) } })));
  }
  /**
   * Removes finished records beyond the newest `records` or older than `days`.
   * Records a recovery still needs, unfinished, partial and uncertain ones stay.
   */
  async pruneHistory(records = this.retention().records, days = this.retention().days): Promise<number> {
    return this.exclusive(async () => {
      const data = await this.read(), needed = new Set([data.localApply?.history, data.partialSend?.history]);
      const entries = await this.records(), cutoff = Date.now() - days * 86_400_000;
      const removed = entries.filter((entry, index) => (records > 0 && index >= records || days > 0 && Date.parse(entry.time) < cutoff)
        && !needed.has(entry.id) && !['started', 'partial', 'uncertain'].includes(entry.outcome));
      for (const entry of removed) await unlink(await this.path(`history/${entry.id}.json`));
      const remaining = entries.filter(entry => !removed.includes(entry));
      const kept = new Set(remaining.flatMap(entry => [...entry.files.flatMap(file => [file.before, file.after]), ...Object.values(entry.observed?.files ?? {})])
        .map(value => typeof value === 'string' ? undefined : value.blob));
      // Picture bytes: those a kept record names, and those an interrupted Apply may still restore.
      const pictures = new Set([...remaining.flatMap(entry => (entry.pictures ?? []).flatMap(picture => picture.before ? [picture.before.hash] : [])),
        ...Object.values(data.localApply?.pictures ?? {}).flatMap(picture => picture.before ? [picture.before] : [])]);
      let blobs: string[] = [];
      try { blobs = await readdir(await this.path('history/blobs')); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
      for (const name of blobs) if (/^[0-9a-f]{64}\.txt$/.test(name) && !kept.has(name.slice(0, 64)) || /^[0-9a-f]{40}\.bin$/.test(name) && !pictures.has(name.slice(0, 40))) await unlink(await this.path(`history/blobs/${name}`));
      return removed.length;
    });
  }
  async historyUsage(): Promise<{ records: number; bytes: number }> {
    let bytes = 0, records = 0;
    for (const dir of ['history', 'history/blobs']) {
      let names: string[] = [];
      try { names = await readdir(await this.path(dir)); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
      for (const name of names.filter(name => /\.(json|txt|bin)$/.test(name))) { bytes += (await stat(await this.path(`${dir}/${name}`))).size; if (dir === 'history') records++; }
    }
    return { records, bytes };
  }
  newHistory(direction: SyncHistory['direction'], files: SyncHistory['files'], comments: CommentChange[]): SyncHistory {
    return { id: `${Date.now()}-${randomUUID()}`, time: new Date().toISOString(), direction, project: this.projectId, outcome: 'started', files, comments, completed: [], warnings: [] };
  }
}
