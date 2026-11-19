import { randomUUID } from 'node:crypto';
import type { DocState, Inspection, ProjectTree, Suggestion, Thread } from './models';
import { ProjectStore, ProjectData, CommentDraft, CommentChange, CommentKind, SyncHistory, SendCheck, isDecision, draftStep, isSentPicture } from './projectStore';
import { Decision, SuggestionRef, countSuggestion, findSuggestion, rejectLocally, sameSuggestion, suggestionRef, visibleAfter } from './suggestions';
import type { Cache } from './storage';
import { readSaved, replaceSaved, sameSaved, mergeSaved, mergeConflict, SavedTexts } from './savedFiles';
import { guardedWrite, validateUpload } from './guard';
import { diffText, changedLines } from './diff';
import { mapDocument, Mapping } from './ranges';
import { OverleafReader, RemoteSession, RefreshScope } from './overleaf';
import { SyncError, safeError } from './errors';
import { checkCancelled, progress } from './operation';
import { LocalReviewFiles } from './reviewFiles';
import { IncomingPicture, OutgoingPicture, PictureState, contentType, outgoingSummary, parentFolders, planOutgoing, sendsPicture, defaultUploadLimit, gitBlobSha1, localPicture, needsDownload, pictureConflict, planPictures, readPicture, replacePicture, samePictures, writesPicture } from './pictures';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';

export const remoteTexts = (inspection: Inspection): Record<string, string> => Object.fromEntries(inspection.docs.map(doc => [doc.path, doc.text]));
export const fingerprint = (value: unknown): string => JSON.stringify(value, (_, item) => item && !Array.isArray(item) && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
export function sameRemote(a: Inspection, b: Inspection, _cache?: Cache): boolean {
  const stable = (i: Inspection) => ({ project: i.projectId, user: i.userId, tracking: i.trackChanges, missing: i.missingFiles,
    docs: [...i.docs].sort((a, b) => a.path.localeCompare(b.path)), threads: i.threads });
  return fingerprint(stable(a)) === fingerprint(stable(b));
}
/**
 * Same files, suggestions and comments, ignoring Overleaf's version numbers
 * (and suggestion IDs derived from them). An edit that was undone changes the
 * version but leaves nothing to review. Staleness checks before writing still
 * use sameRemote, which includes versions.
 *
 * A suggestion's author fields are ignored too: the name is resolved from
 * project members and comments, and older baselines lack authorId. Neither
 * changes the suggestion, whose position, text and timestamp still count.
 */
export function sameContent(a: Inspection, b: Inspection): boolean {
  // Paths absent on Overleaf are not content: a file missing there changes `docs`.
  const stable = (i: Inspection) => ({ project: i.projectId, user: i.userId, tracking: i.trackChanges, threads: i.threads,
    docs: [...i.docs].sort((x, y) => x.path.localeCompare(y.path)).map(({ version: _version, diagnostics: _diagnostics, changes, ...doc }) => ({ ...doc, changes: changes.map(({ id: _id, author: _author, authorId: _authorId, ...change }) => change) })) });
  return fingerprint(stable(a)) === fingerprint(stable(b));
}
const threadPath = (inspection: Inspection | undefined, id: string) => inspection?.docs.find(doc => doc.comments.some(anchor => anchor.threadId === id))?.path;
// What a reader sees of an anchor: its file, state and selected text. Offsets
// alone shift with every edit above the comment and are shown by the file diff.
function anchorView(inspection: Inspection | undefined, id: string) {
  for (const doc of inspection?.docs ?? []) {
    const anchor = doc.comments.find(item => item.threadId === id);
    if (anchor) return { path: doc.path, state: anchor.state, text: anchor.ranges.map(range => doc.text.slice(range.pos, range.pos + range.length)).join('') };
  }
}
const lineAt = (text: string, pos: number) => text.slice(0, pos).split('\n').length;
/** Where a thread's commented text starts, for display only. */
function anchorLine(inspection: Inspection | undefined, id: string): number | undefined {
  for (const doc of inspection?.docs ?? []) {
    const range = doc.comments.find(item => item.threadId === id)?.ranges[0];
    if (range) return lineAt(doc.text, range.pos);
  }
}
export function incomingComments(before: Inspection | undefined, after: Inspection): CommentChange[] {
  const ids = new Set([...Object.keys(before?.threads ?? {}), ...Object.keys(after.threads), ...[...(before?.docs ?? []), ...after.docs].flatMap(doc => doc.comments.map(anchor => anchor.threadId))]);
  const result: CommentChange[] = [];
  for (const id of ids) {
    const old = before?.threads[id], next = after.threads[id];
    const oldAnchor = anchorView(before, id), nextAnchor = anchorView(after, id);
    const anchorChanged = fingerprint(oldAnchor) !== fingerprint(nextAnchor), threadChanged = fingerprint(old) !== fingerprint(next);
    if (!threadChanged && !anchorChanged) continue;
    const label = !old ? 'New thread' : !next ? 'Deleted thread' : threadChanged ? 'Updated thread'
      : oldAnchor?.path !== nextAnchor?.path ? 'Comment moved to another file' : oldAnchor?.state !== nextAnchor?.state ? !nextAnchor || nextAnchor.state === 'anchor removed' ? 'Commented text deleted' : `Anchor ${nextAnchor.state}` : 'Anchor text changed';
    const line = anchorLine(after, id) ?? anchorLine(before, id);
    result.push({ id, threadId: id, path: threadPath(after, id) ?? threadPath(before, id) ?? 'Unplaced or unselected file', label, ...line && { line }, before: old, after: next, anchorChanged,
      ...anchorChanged && { anchorText: nextAnchor?.text, anchorBefore: oldAnchor?.text } });
  }
  return result;
}
function draftThread(before: Thread | undefined, draft: CommentDraft, userId?: string): Thread | undefined {
  if (draft.kind === 'deleteThread') return undefined;
  const next = structuredClone(before ?? { id: draft.threadId, resolved: false, messages: [] });
  if (draft.kind === 'createThread' || draft.kind === 'reply') next.messages.push({ id: `draft:${draft.id}`, author: 'You', authorId: userId, text: draft.text!, timestamp: draft.created });
  if (draft.kind === 'editMessage') next.messages = next.messages.map(message => message.id === draft.messageId ? { ...message, text: draft.text! } : message);
  if (draft.kind === 'deleteMessage') next.messages = next.messages.filter(message => message.id !== draft.messageId);
  if (draft.kind === 'resolve' || draft.kind === 'reopen') next.resolved = draft.kind === 'resolve';
  return next;
}
export function projectedInspection(data: ProjectData): Inspection | undefined {
  if (!data.acknowledged) return;
  const result = structuredClone(data.acknowledged);
  // Upgrade display names in older cached snapshots without changing the
  // accepted sync baseline or requiring an Apply just to identify a reviewer.
  const authors = new Map<string, string>();
  for (const thread of Object.values(result.threads)) for (const message of thread.messages) {
    if (message.authorId && message.author !== message.authorId && message.author !== 'Unknown author') authors.set(message.authorId, message.author);
  }
  for (const doc of result.docs) for (const change of doc.changes) {
    const id = change.authorId ?? change.author, name = authors.get(id);
    if (name) { change.authorId = id; change.author = name; }
  }
  // Suggestion decisions take effect on Send; until then the suggestion stays as Overleaf has it.
  for (const draft of data.pending.filter(draft => !isDecision(draft))) {
    const next = draftThread(result.threads[draft.threadId], draft, result.userId);
    if (next) result.threads[draft.threadId] = next;
    else { delete result.threads[draft.threadId]; result.docs.forEach(doc => { doc.comments = doc.comments.filter(anchor => anchor.threadId !== draft.threadId); }); }
    if (draft.kind === 'createThread' && draft.anchor) {
      const doc = result.docs.find(doc => doc.path === draft.path);
      // Mapping against the acknowledged source is performed by the editor.
      // For a newly selected local range, use its saved source as the mapping basis.
      if (doc) {
        const pos = draft.anchor.from, length = draft.anchor.to - pos;
        const mapped = mapDocument({ ...doc, text: draft.anchor.source, rawContent: draft.anchor.source, rawChanges: [], comments: [{ threadId: draft.threadId, ranges: [{ pos, length }], rawRanges: [{ pos, length }], state: 'placed' }] }, doc.text).comments[0];
        doc.comments.push(mapped);
      }
    }
  }
  return result;
}
export const draftLabels: Record<CommentDraft['kind'], string> = { createThread: 'New comment', reply: 'Reply', editMessage: 'Edit message', deleteMessage: 'Delete message', deleteThread: 'Delete thread', resolve: 'Resolve thread', reopen: 'Reopen thread', acceptChange: 'Accept suggestion', rejectChange: 'Reject suggestion' };
export const decisionOf = (draft: CommentDraft): Decision => draft.kind === 'acceptChange' ? 'accept' : 'reject';
export function outgoingComments(inspection: Inspection, pending: CommentDraft[]): CommentChange[] {
  const threads = structuredClone(inspection.threads);
  return pending.map(draft => {
    if (isDecision(draft)) {
      const doc = inspection.docs.find(doc => doc.docId === draft.docId), change = draft.change!, index = doc ? findSuggestion(doc, change) : -1;
      const pos = index >= 0 ? doc!.changes[index].pos : change.pos;
      const line = lineAt(doc?.text ?? '', pos);
      return { id: draft.id, draftId: draft.id, path: draft.path, label: draftLabels[draft.kind], line, suggestion: { decision: decisionOf(draft), kind: change.kind, text: change.text, author: change.author, line } };
    }
    const before = threads[draft.threadId], after = draftThread(before, draft, inspection.userId);
    if (after) threads[draft.threadId] = after; else delete threads[draft.threadId];
    // What the comment is on: the selection for a new thread, otherwise the anchored text.
    const anchor = draft.anchor ? { text: draft.anchor.source.slice(draft.anchor.from, draft.anchor.to), line: lineAt(draft.anchor.source, draft.anchor.from) } : { text: anchorView(inspection, draft.threadId)?.text, line: anchorLine(inspection, draft.threadId) };
    return { id: draft.id, draftId: draft.id, threadId: draft.threadId, path: draft.path, label: draftLabels[draft.kind], ...anchor?.line && { line: anchor.line }, before, after, ...anchor?.text && { anchorText: anchor.text } };
  });
}
// create: the file is only local and never synchronized, so Send creates it on
// Overleaf (with these missing folders, parents first); `doc` is then an empty
// placeholder. remove: Undo this send deletes the file that Send created.
export interface PushFile { doc: DocState; bytes: Buffer; text: string; mapping: Mapping; added: number; removed: number;
  create?: { folders: string[] }; remove?: { docId: string; folders: { path: string; id: string }[] }; }
interface Plan { inspection: Inspection; cache: Cache; saved: SavedTexts; revision?: string; pending: CommentDraft[]; comments: CommentChange[]; }
// incoming: Overleaf changed since the last sync without overlapping local
// edits. Send first applies it locally (as Get latest would), then sends `files`.
// local: the files after Send, with rejected suggestions removed or restored as on Overleaf.
// remote, operations, undoOf: set only by Undo this send. `remote` is the text
// Overleaf must hold afterwards when it differs from the local files, and
// `operations` are sent in place of the queued drafts, which stay queued.
/**
 * pictures: the picture rows of a Send or of Undo this send (absent with `turnleaf.syncPictures`
 * off), blocked rows included; pictureBase: the picture state they were planned from.
 */
export interface PushPlan extends Plan { files: PushFile[]; incoming?: PullPlan; local: SavedTexts; remote?: SavedTexts; operations?: CommentDraft[]; undoOf?: string;
  pictures?: OutgoingPicture[]; pictureBase?: PictureState; }
/** Why nothing can be sent now, and the one way out: recover the interrupted Apply, Get latest, discard or revise a draft, or fix what the sentence names. */
export interface SendBlock { way: 'recover' | 'getLatest' | 'draft' | 'fix'; message: string; code: string; draftId?: string; }
export type SendPlan = { plan: PushPlan; blocked?: undefined } | { plan?: undefined; blocked: SendBlock };
class Blocked extends SyncError { constructor(readonly block: SendBlock) { super(block.message, block.code); } }
const blocked = (way: SendBlock['way'], message: string, code: string, draftId?: string) => new Blocked({ way, message, code, ...draftId && { draftId } });
/** A row of an undo summary that stays as sent, with the reason. */
export interface UndoRow { key: string; label: string; path?: string; reason: string; }
/** What Undo this send takes back from Overleaf (`plan`, `files`) and what stays as sent. Local files and queued drafts are not part of it. */
export interface UndoPlan { record: string; time: string; plan: PushPlan; files: { path: string; added: number; removed: number; note?: string; mark?: string }[]; stays: UndoRow[]; }
/**
 * Row keys where `next` differs from the plan `shown` in the summary; empty when
 * a click on `shown` may send `next`. Overleaf's version numbers are ignored,
 * every text and comment that would be written or replaced is compared.
 */
export function planDifferences(shown: PushPlan, next: PushPlan): string[] {
  const changed: string[] = [];
  const compare = <T>(prefix: string, a: T[], b: T[], key: (item: T) => string, value: (item: T) => unknown) => {
    const left = new Map(a.map(item => [key(item), fingerprint(value(item))])), right = new Map(b.map(item => [key(item), fingerprint(value(item))]));
    for (const id of new Set([...left.keys(), ...right.keys()])) if (left.get(id) !== right.get(id)) changed.push(`${prefix}:${id}`);
  };
  // Suggestions added on Overleaf can leave the text equal and still change what this edit overwrites.
  compare('file', shown.files, next.files, file => file.doc.path, file => [file.doc.text, file.text, lostAnchors(file.mapping), file.mapping.affectedSuggestions.length, file.create ?? null, file.remove?.docId ?? null]);
  compare('comment', shown.comments, next.comments, change => change.id, change => change);
  compare('picture', shown.pictures ?? [], next.pictures ?? [], picture => picture.path, picture => [picture.kind, picture.hash ?? null, picture.remote ?? null, picture.folders ?? null, picture.note ?? null]);
  compare('incoming', shown.incoming?.files ?? [], next.incoming?.files ?? [], file => file.path, file => [file.before, file.after]);
  compare('incoming-comment', shown.incoming?.comments ?? [], next.incoming?.comments ?? [], change => change.id, change => change);
  compare('remote', Object.entries(shown.remote ?? {}), Object.entries(next.remote ?? {}), ([path]) => path, ([, text]) => text);
  if (shown.comments.map(change => change.id).join('\0') !== next.comments.map(change => change.id).join('\0')) changed.push('comment-order');
  if (!!shown.inspection.trackChanges !== !!next.inspection.trackChanges) changed.push('track-changes');
  return changed;
}
const lostAnchors = (mapping: Mapping) => ({ deleted: mapping.comments.filter(anchor => anchor.label === 'deleted locally').length, edited: mapping.comments.filter(anchor => anchor.label === 'edited locally').length });
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
// What an edit detaches or overwrites on Overleaf, in words; empty when nothing.
function lostText(mapping: Mapping): string {
  const { deleted, edited } = lostAnchors(mapping), suggestions = mapping.affectedSuggestions.length;
  return [deleted && count(deleted, 'comment loses its text', 'comments lose their text'), edited && count(edited, 'comment on edited text', 'comments on edited text'), suggestions && count(suggestions, 'suggestion overwritten', 'suggestions overwritten')].filter(Boolean).join(', ');
}
/**
 * Rows of a Send summary that Undo this send could not bring back, with the
 * reason. Keys as in `planDifferences`: `file:<path>`, `comment:<draft id>`.
 */
export function irreversible(plan: PushPlan): Record<string, string> {
  const marks: Record<string, string> = {};
  for (const file of plan.files) {
    const lost = lostText(file.mapping);
    if (lost) marks[`file:${file.doc.path}`] = lost;
  }
  for (const draft of plan.operations ?? plan.pending) {
    const reason = draft.kind === 'deleteThread' ? 'A deleted thread cannot be restored' : draft.kind === 'deleteMessage' ? 'A deleted message cannot be restored' : isDecision(draft) ? 'A decided suggestion cannot become a suggestion again' : '';
    if (reason) marks[`comment:${draft.id}`] = reason;
  }
  return marks;
}
const kindOf = Object.fromEntries(Object.entries(draftLabels).map(([kind, label]) => [label, kind])) as Record<string, CommentKind | undefined>;
// What a Send record says about its comment changes and edits. Records written
// before `sent` existed: the kind from the label, the created message from the read-back.
function sentInfo(record: SyncHistory, userId?: string): { files: NonNullable<SyncHistory['sent']>['files']; comments: Record<string, { kind?: CommentKind; messageId?: string } | undefined> } {
  if (record.sent) return record.sent;
  const comments: Record<string, { kind?: CommentKind; messageId?: string }> = {};
  for (const change of record.comments) {
    // Earlier replies of the same Send are placeholders in this thread too: take this change's own.
    const kind = kindOf[change.label], drafted = change.after?.messages.find(message => message.id === `draft:${change.id}`);
    const made = drafted ? (record.observed?.comments[change.threadId ?? '']?.messages ?? []).filter(message => message.text === drafted.text && (!userId || message.authorId === userId) && !change.before?.messages.some(old => old.id === message.id)) : [];
    const edited = kind === 'editMessage' ? change.after?.messages.find(message => change.before?.messages.find(old => old.id === message.id)?.text !== message.text)?.id : undefined;
    comments[change.id] = { kind, messageId: made.length === 1 ? made[0].id : edited };
  }
  return { files: {}, comments };
}
// firstSync: no acknowledged baseline exists, so the user picks a version or merges manually.
export interface IncomingFile { path: string; before: string; after: string; base: string; remote: string; conflict: boolean; added: number; removed: number; firstSync?: boolean; conflictLine?: number; }
/**
 * pictures: the picture rows of a Get latest preview (absent where pictures are not
 * planned: in the summary of Send, or with `turnleaf.syncPictures` off).
 * pictureLocal: the local hash (null: absent) of every picture path Apply relies on;
 * pictureBase and pictureNext: the picture baseline when planned, and after Apply.
 */
export interface PullPlan extends Plan { proposed: SavedTexts; files: IncomingFile[];
  pictures?: IncomingPicture[]; pictureLocal?: Record<string, string | null>; pictureBase?: PictureState; pictureNext?: PictureState; }
/** Whether Apply of this plan changes anything: files, comments, pictures or the picture baseline. */
export const pullChanges = (plan: PullPlan): boolean => !!plan.files.length || !!plan.comments.length || !!plan.pictures?.length || fingerprint(plan.pictureBase ?? null) !== fingerprint(plan.pictureNext ?? plan.pictureBase ?? null);

// During Send: only the files it creates or deletes may be absent on Overleaf.
function present(inspection: Inspection, allowed: string[]): Inspection {
  const missing = inspection.missingFiles.filter(path => !allowed.includes(path));
  if (missing.length) throw new SyncError(`Missing Overleaf source files: ${missing.join(', ')}. Get latest before sending again.`, 'missing');
  return inspection;
}
const has = (record: Record<string, string> | undefined, key: string) => !!record && Object.hasOwn(record, key);
// Live events that change the project tree (Overleaf's own spelling).
const treeEvents = new Set(['reciveNewDoc', 'reciveNewFile', 'reciveNewFolder', 'removeEntity', 'reciveEntityRename', 'reciveEntityMove']);
/** The folders of `path` that are not on Overleaf, parents first. */
export const missingFolders = (path: string, folders: Record<string, string>): string[] =>
  path.split('/').slice(0, -1).map((_, n, parts) => parts.slice(0, n + 1).join('/')).filter(folder => !has(folders, folder));
/**
 * Selected paths that Overleaf does not have. `created`: only local and never
 * synchronized, so Send creates them on Overleaf. Any other absent path stops
 * Get latest and Send with the reason: Send never brings back a file that was
 * deleted or renamed on Overleaf since the last sync.
 */
/**
 * The baseline without the files that an interrupted Undo this send deleted, or
 * may have deleted: their absence on Overleaf is that Undo's, not a coauthor's,
 * so Get latest treats them as local-only (new on Overleaf) again.
 */
function withoutUndoDeletions(data: ProjectData): Inspection | undefined {
  const steps = [...data.partialSend?.confirmed ?? [], ...data.partialSend?.uncertain ?? []];
  const deleted = new Set(steps.filter(step => step.startsWith('delete:')).map(step => step.slice('delete:'.length)));
  if (!deleted.size || !data.acknowledged) return data.acknowledged;
  return { ...data.acknowledged, docs: data.acknowledged.docs.filter(doc => !deleted.has(doc.path)) };
}
export function absentOnOverleaf(acknowledged: Inspection | undefined, fresh: Inspection, saved: SavedTexts): { created: string[]; problem?: string } {
  const created: string[] = [], problems: string[] = [];
  for (const path of fresh.missingFiles) {
    if (fresh.tree?.files.includes(path)) problems.push(`${path} exists on Overleaf, but not as a text file: Overleaf stores it as a file (as it does for text over 1 MB or not in UTF-8), so it cannot be synchronized as text. Remove it in Choose files, or make it a text document on Overleaf.`);
    else if (has(fresh.tree?.folders, path)) problems.push(`${path} exists on Overleaf, but not as a text file. Rename one of them.`);
    else if (acknowledged?.docs.some(doc => doc.path === path)) problems.push(`${path} was deleted or renamed on Overleaf since your last sync. Send does not bring it back: restore it on Overleaf, or remove it in Choose files.`);
    else if (saved[path] === null || saved[path] === undefined) problems.push(`${path} is missing in the local folder and on Overleaf. Remove it in Choose files.`);
    else created.push(path);
  }
  return { created, ...problems.length && { problem: problems.join(' ') } };
}
export class SyncService {
  readonly root: string; readonly projectId: string; readonly paths: string[];
  // `live` supplies the open realtime session when there is one; reads then
  // reuse it instead of opening a new connection each time.
  constructor(readonly state: ProjectStore, private readonly client: OverleafReader | (() => Promise<OverleafReader>), private readonly live?: () => Promise<RemoteSession | undefined>) {
    this.root = state.root; this.projectId = state.projectId; this.paths = state.paths;
  }
  /** Read by each Send. Fast applies only through the live connection; without one, Send reads in full. */
  sendCheck: () => SendCheck = () => 'full';
  async remote(): Promise<OverleafReader> { return typeof this.client === 'function' ? this.client() : this.client; }
  async liveSession(): Promise<RemoteSession | undefined> { return this.live?.(); }
  async fetchPull(scope?: RefreshScope): Promise<Inspection> {
    const live = await this.live?.();
    // Absent files are classified by the plans (absentOnOverleaf), which know the baseline.
    return live ? await live.refresh(scope) : await (await this.remote()).inspect(this.projectId, this.paths);
  }
  async refresh(): Promise<Inspection> {
    const fresh = await this.fetchPull(); await this.state.update(data => { data.observed = fresh; }); return fresh;
  }
  async saveRefresh(fresh: Inspection): Promise<void> { await this.state.update(data => { data.observed = fresh; }); }
  async checkLocal(plan: Plan, valid: () => boolean): Promise<void> {
    await new LocalReviewFiles(this.state).importEdits();
    const data = await this.state.read();
    if (!valid() || data.revision !== plan.revision || fingerprint(data.pending) !== fingerprint(plan.pending) || !sameSaved(await readSaved(this.root, this.paths, true), plan.saved)) throw new SyncError('Saved files, comment drafts, or the sync baseline changed. Review again.', 'stale');
  }
  async push(plan: PushPlan, valid: () => boolean, output: (line: string) => void): Promise<{ inspection: Inspection; snapshot: string; mismatches: string[]; warnings: string[]; history: string }> {
    return this.state.exclusive(async () => {
      const history = this.state.newHistory('send', plan.files.map(file => ({ path: file.doc.path, before: file.doc.text, after: file.text })), plan.comments);
      // What Undo this send needs beyond the file texts.
      const sent: NonNullable<SyncHistory['sent']> = history.sent = { ...plan.inspection.trackChanges !== undefined && { trackChanges: plan.inspection.trackChanges }, files: {}, comments: {} };
      if (plan.undoOf) history.undoOf = plan.undoOf;
      // A normal Send writes the queued drafts and leaves Overleaf equal to the local files.
      const operations = plan.operations ?? plan.pending, wanted = plan.remote ?? plan.local;
      await this.state.writeHistory(history);
      let session: RemoteSession | undefined, attempted: string | undefined, stopTree: (() => void) | undefined;
      const treeLog: { name: string; args: unknown[] }[] = [], pictures = (plan.pictures ?? []).filter(sendsPicture);
      let pictureNow = plan.pictureBase;
      const reader = await this.remote(), live = await this.live?.();
      // One connection for the whole Send: the live session, or a dedicated one.
      const absent = plan.files.filter(file => file.create || file.remove).map(file => file.doc.path);
      const read = async (scope?: RefreshScope) => present(await session!.refresh(scope), absent);
      // Fast: the live connection has been joined to every selected file and reports each
      // edit, so the checks around the writes re-read only reported and written files.
      const fast = this.sendCheck() === 'fast' && !!live, written = new Set<string>();
      history.check = { mode: fast ? 'fast' : 'full', ...this.sendCheck() === 'fast' && !live && { note: 'no live connection' } };
      const reported = () => session!.inspection.docs.filter(doc => session!.socket.updates.some(update => update.doc === doc.docId && update.v >= doc.version)).map(doc => doc.docId);
      const check = () => read(fast ? { docs: [...new Set([...written, ...reported()])] } : undefined);
      try {
        await this.checkLocal(plan, valid);
        const data = await this.state.read();
        if (data.localApply || data.partialSend) throw new SyncError('Review the interrupted sync before sending again.', 'recovery');
        // Files stay joined until Send ends, so 'changed' re-reads see every edit.
        session = live ?? await reader.openSession(this.projectId, this.paths, { live: true });
        // Tree events since a step's last tree read: a coauthor's upload, delete, rename or move.
        stopTree = session.socket.onEvent((name, args) => { if (treeEvents.has(name)) treeLog.push({ name, args: Array.isArray(args) ? args : [] }); });
        if (live) await check();
        if (!sameRemote(plan.inspection, session.inspection)) throw new SyncError('Overleaf changed during review. Get latest and review again.', 'stale');
        await this.checkLocal(plan, valid);
        const fence = async (id: string) => {
          attempted = id;
          await this.state.update(data => { data.partialSend = { history: history.id, confirmed: [...history.completed], uncertain: [id] }; });
        };
        const exists = (tree: ProjectTree, path: string) => has(tree.docs, path) || tree.files.includes(path) || has(tree.folders, path);
        const step = async (name: string) => { history.completed.push(name); attempted = undefined; await this.state.writeHistory(history); };
        // A new file: its missing folders, an empty document (Overleaf refuses a
        // name that exists), each read back by ID, then the content as one
        // untracked versioned edit, as Overleaf's own upload writes it.
        // The missing folders of a new file, parents first, each created and read back by ID.
        // Folders made earlier in this Send are in the tree; any other missing folder was not in the summary.
        // `start` is a tree read moments ago; each read opens the project, and Overleaf limits opens per minute.
        const makeFolders = async (path: string, reviewed: string[], start?: ProjectTree) => {
          const open = session!, made: { path: string; id: string }[] = [];
          let tree = start ?? await reader.projectTree(this.projectId), folderId = tree.folders[''];
          if (!folderId) throw new SyncError('Overleaf did not report the project\'s root folder. Get latest before sending again.', 'protocol');
          const parents = parentFolders(path);
          const unreviewed = parents.filter(folder => !has(tree.folders, folder) && !reviewed.includes(folder));
          if (unreviewed.length) throw new SyncError(`The folder ${unreviewed.join(', ')} is no longer on Overleaf, so ${path} needs a folder that the summary did not show. Get latest again.`, 'stale');
          for (const folder of parents) {
            if (has(tree.folders, folder)) { folderId = tree.folders[folder]; continue; }
            if (exists(tree, folder)) throw new SyncError(`${folder} exists on Overleaf as a file, so the folder for ${path} cannot be created.`, 'stale');
            await this.checkLocal(plan, valid);
            const parent = folderId;
            const id = await guardedWrite(this.state, { kind: 'createFolder', projectId: this.projectId, path: folder, folderId: parent }, valid, async () => true, async permit => {
              await fence(`folder:${folder}`); return reader.write(permit, open);
            }, output);
            tree = await reader.projectTree(this.projectId);
            if (typeof id !== 'string' || tree.folders[folder] !== id) throw new SyncError(`The folder ${folder} could not be verified on Overleaf after creating it. Inspect Sync history before retrying.`, 'verification');
            made.push({ path: folder, id }); folderId = id;
            await step(`folder:${folder}`);
          }
          return { folderId, made, tree };
        };
        // Only a refusal (HTTP 4xx, e.g. the name exists now) shows that nothing was
        // written. Any other unclear answer stays uncertain, even when one read of the
        // tree shows nothing: the request may still complete afterwards.
        const refused = (error: unknown) => error instanceof SyncError && error.status !== undefined && error.status >= 400 && error.status < 500;
        const unfence = async () => { attempted = undefined; await this.state.update(data => { if (history.completed.length) data.partialSend = { history: history.id, confirmed: [...history.completed], uncertain: [] }; else delete data.partialSend; }); };
        const createFile = async (file: PushFile) => {
          const path = file.doc.path, open = session!;
          progress(`Creating ${path} on Overleaf…`); await this.checkLocal(plan, valid);
          const before = await reader.projectTree(this.projectId);
          if (exists(before, path) || open.inspection.docs.some(doc => doc.path === path)) throw new SyncError(`${path} now exists on Overleaf. Get latest: it then offers Use Overleaf version, Keep my version or Merge manually.`, 'stale');
          let { folderId, made, tree } = await makeFolders(path, file.create!.folders, before);
          await this.checkLocal(plan, valid);
          let id: string | void;
          try {
            id = await guardedWrite(this.state, { kind: 'createDoc', projectId: this.projectId, path, folderId }, valid, async () => true, async permit => {
              await fence(`create:${path}`); return reader.write(permit, open);
            }, output);
          } catch (error) {
            if (attempted !== `create:${path}`) throw error;
            if (refused(error)) {
              const now = await reader.projectTree(this.projectId).catch(() => undefined), there = !!now && exists(now, path);
              await unfence();
              throw there ? new SyncError(`${path} now exists on Overleaf. Get latest: it then offers Use Overleaf version, Keep my version or Merge manually.`, 'stale', undefined, error)
                : new SyncError(`Overleaf did not create ${path} (${safeError(error)}). Nothing was created for it.`, error instanceof SyncError ? error.code : 'upload', undefined, error);
            }
            throw new SyncError(`${path} now exists on Overleaf: created by a coauthor in the same moment, or by this Send without a clear answer. Get latest: it then offers Use Overleaf version, Keep my version or Merge manually.`, 'upload', undefined, error);
          }
          tree = await reader.projectTree(this.projectId);
          if (typeof id !== 'string' || tree.docs?.[path] !== id) throw new SyncError(`${path} could not be verified on Overleaf after creating it. Inspect Sync history before retrying.`, 'verification');
          await step(`create:${path}`);
          let doc = await open.track(path, id, folderId, tree); written.add(id);
          if (doc.text !== '' || doc.version > 1) throw new SyncError(`${path} changed on Overleaf right after creating it (expected an empty file at its first version). Get latest before sending again.`, 'verification');
          if (file.text) {
            await this.checkLocal(plan, valid);
            const version = doc.version;
            await guardedWrite(this.state, { kind: 'edit', projectId: this.projectId, path, docId: id, bytes: file.bytes, version, untracked: true }, valid, async () => true, async permit => {
              await fence(`file:${path}`); await reader.write(permit, open);
            }, output);
            doc = await open.rejoin(doc);
            history.observed ??= { time: new Date().toISOString(), files: {}, comments: {} };
            history.observed.files[path] = doc.text; history.observed.time = new Date().toISOString();
            if (doc.text !== file.text) throw new SyncError(`${path} was created on Overleaf, but its content differs from the reviewed content. Get latest: the file is then on both sides without a shared version, and Keep my version sends it again.`, 'verification');
          }
          (sent.created ??= {})[path] = { docId: id, folders: made };
          sent.files[path] = { suggestions: [], lostComments: 0, lostSuggestions: 0 };
          await step(`file:${path}`);
        };
        // Undo this send of a created file: delete it while it is as sent. Overleaf's
        // delete takes no condition, so the live connection is checked for an edit or
        // comment on it in the last moment before the request. Folders that the Send
        // created stay: deleting a folder would delete whatever a coauthor put in it.
        const removeFile = async (file: PushFile) => {
          const path = file.doc.path, open = session!, remove = file.remove!;
          progress(`Deleting ${path} from Overleaf…`); await this.checkLocal(plan, valid);
          const before = await open.rejoin(file.doc);
          if (before.version !== file.doc.version || before.text !== file.doc.text || before.comments.length || before.changes.length) throw new SyncError(`${path} changed on Overleaf. Get latest again.`, 'stale');
          let tree = await reader.projectTree(this.projectId);
          if (tree.docs?.[path] !== remove.docId) throw new SyncError(`${path} changed on Overleaf. Get latest again.`, 'stale');
          await this.checkLocal(plan, valid);
          const touched = () => open.socket.updates.some(event => event.doc === remove.docId && event.v >= before.version);
          await guardedWrite(this.state, { kind: 'deleteDoc', projectId: this.projectId, path, docId: remove.docId }, valid, async () => true, async permit => {
            if (touched()) throw new SyncError(`${path} was edited on Overleaf just now, so it was not deleted. Get latest again.`, 'stale');
            await fence(`delete:${path}`); await reader.write(permit, open);
          }, output);
          tree = await reader.projectTree(this.projectId);
          if (has(tree.docs, path)) throw new SyncError(`${path} is still on Overleaf after deleting it. Inspect Sync history before retrying.`, 'verification');
          await open.untrack(path, tree);
          await step(`delete:${path}`);
        };
        // A picture: an upload over the reviewed Overleaf file or a new one, and in
        // Undo this send the upload back of the replaced bytes or the delete of the
        // created file. Each one only while Overleaf has exactly what the summary
        // showed, checked on a fresh tree read and on the live connection in the last
        // moment before the request; read back by ID and hash.
        const sendPicture = async (picture: OutgoingPicture) => {
          const path = picture.path, open = session!, name = path.slice(path.lastIndexOf('/') + 1);
          const stale = (message: string) => new SyncError(message, 'stale');
          progress(`${picture.kind === 'delete' ? 'Deleting' : 'Uploading'} ${path}…`); await this.checkLocal(plan, valid);
          if (fingerprint(await this.state.pictures()) !== fingerprint(pictureNow)) throw stale('The picture baseline changed. Review again.');
          const local = async () => (await localPicture(this.root, path, Infinity).catch(() => undefined))?.hash;
          // The local copy that goes out must be the reviewed one.
          if ((picture.kind === 'replace' || picture.kind === 'create') && await local() !== picture.hash) throw stale(`${path}: local contents changed. Review again.`);
          const parent = (tree: ProjectTree) => tree.folders[path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''];
          // The Overleaf state the step expects: no text document of that name ever,
          // a plain file with the expected hash, or nothing for a create.
          const expect = (tree: ProjectTree) => {
            if (has(tree.docs, path)) throw stale(`${path} is a text document on Overleaf now. An upload would replace it and lose its comments, so nothing was sent for it. Get latest again.`);
            const file = tree.fileRefs?.[path];
            if (picture.kind === 'create') {
              if (file || tree.files.includes(path) || has(tree.folders, path)) throw stale(`${path} now exists on Overleaf. Get latest to compare and choose a version.`);
              return undefined;
            }
            if (file?.linked) throw stale(`${path} is a linked file on Overleaf now. An upload would drop the link, so nothing was sent for it. Get latest again.`);
            if (!file || file.hash !== picture.remote!.hash || picture.kind === 'delete' && file.id !== picture.remote!.id) throw stale(`${path} changed on Overleaf. Get latest again.`);
            return file;
          };
          // Tree events from here on: the live connection reports a coauthor's change
          // that this read does not show (a tree read opens the project, which
          // Overleaf limits per minute, so the step reads it again only after folders).
          const since = treeLog.length;
          let tree = await reader.projectTree(this.projectId), file = expect(tree);
          const entry = { path, kind: `send-${picture.kind}`, before: null as { hash: string; size: number } | null, after: null as { hash: string; size: number } | null };
          let bytes: Buffer | undefined;
          if (picture.kind === 'replace') {
            // The bytes this upload replaces, kept in Sync history first.
            const replaced = await reader.downloadFile(this.projectId, path, { id: file!.id, hash: picture.remote!.hash }, Infinity);
            await this.state.putBytes(replaced);
            entry.before = { hash: picture.remote!.hash, size: replaced.length };
            bytes = await readPicture(this.root, path, picture.hash!);
          } else if (picture.kind === 'restore') {
            // From Sync history, or once pruned by hash from Overleaf, which keeps replaced bytes.
            bytes = await this.state.getBytes(picture.hash!) ?? await reader.downloadFile(this.projectId, path, { id: file!.id, hash: picture.hash! }, Infinity);
            entry.before = { hash: picture.remote!.hash, size: picture.remote!.size ?? 0 };
          } else if (picture.kind === 'create') bytes = await readPicture(this.root, path, picture.hash!);
          else entry.before = { hash: picture.remote!.hash, size: picture.remote!.size ?? 0 };
          if (bytes) entry.after = { hash: gitBlobSha1(bytes), size: bytes.length };
          (history.pictures ??= []).push(entry); await this.state.writeHistory(history);
          let made: { path: string; id: string }[] = [];
          if (picture.kind === 'create') {
            ({ made, tree } = await makeFolders(path, picture.folders ?? [], tree));
            if (made.length) file = expect(tree);
          }
          const folderId = parent(tree);
          if (!folderId) throw stale(`The folder of ${path} is no longer on Overleaf. Get latest again.`);
          // A coauthor's change that the tree read may not show yet: an entry of this name
          // (new or renamed), this file ID, an entry moved into the target folder (a move
          // event carries only the entity and folder IDs), or a rename, move or delete of a
          // parent folder, after which the folder ID points somewhere the summary did not show.
          const ancestors = new Set(parentFolders(path).map(folder => tree.folders[folder]).filter(Boolean));
          const touched = () => treeLog.slice(since).some(({ name: event, args }) => [name, file?.id].some(key => !!key && JSON.stringify(args).includes(JSON.stringify(key)))
            || event === 'reciveEntityMove' && args[1] === folderId
            || ['reciveEntityRename', 'reciveEntityMove', 'removeEntity'].includes(event) && ancestors.has(args[0] as string));
          await this.checkLocal(plan, valid);
          if (picture.kind === 'replace' || picture.kind === 'create') {
            if (await local() !== picture.hash) throw stale(`${path}: local contents changed. Review again.`);
          }
          let id: string | void;
          try {
            id = await guardedWrite(this.state, picture.kind === 'delete'
              ? { kind: 'deleteFile', projectId: this.projectId, path, fileId: file!.id }
              : { kind: 'uploadFile', projectId: this.projectId, path, folderId, bytes, hash: entry.after!.hash }, valid, async () => true, async permit => {
              if (touched()) throw stale(`${path} changed on Overleaf just now, so nothing was sent for it. Get latest again.`);
              await fence(`picture:${path}`); return reader.write(permit, open);
            }, output);
          } catch (error) {
            if (attempted !== `picture:${path}`) throw error;
            // A refusal wrote nothing; any other unclear answer stays uncertain and is never retried.
            if (refused(error)) { await unfence(); throw new SyncError(`Overleaf refused ${picture.kind === 'delete' ? 'to delete' : 'the upload of'} ${path} (${safeError(error)}). Nothing was written for it.`, error instanceof SyncError ? error.code : 'upload', undefined, error); }
            throw error;
          }
          tree = await reader.projectTree(this.projectId);
          const now = tree.fileRefs?.[path], count = tree.files.filter(item => item === path).length + (has(tree.docs, path) ? 1 : 0);
          if (picture.kind === 'delete') {
            if (now || count) throw new SyncError(`${path} is still on Overleaf after deleting it. Inspect Sync history before retrying.`, 'verification');
          } else if (typeof id !== 'string' || count !== 1 || now?.id !== id || now.hash !== entry.after!.hash || now.linked) throw new SyncError(`${path} could not be verified on Overleaf after uploading it. Inspect Sync history before retrying.`, 'verification');
          if (picture.kind === 'replace' || picture.kind === 'create') sent.files[path] = { ...picture.kind === 'replace' && { replacedHash: picture.remote!.hash }, sentHash: entry.after!.hash, fileId: id as string };
          if (picture.kind === 'create') (sent.created ??= {})[path] = { fileId: id as string, folders: made };
          if (picture.kind === 'restore') sent.files[path] = { sentHash: entry.after!.hash, fileId: id as string };
          await step(`picture:${path}`);
          // The baseline follows each verified step, so a later failure leaves it true.
          const next: PictureState = structuredClone(pictureNow ?? { schema: 1, baseline: {} });
          if (picture.kind === 'delete') { delete next.baseline[path]; next.added = [...new Set([...next.added ?? [], path])].sort(); }
          else { next.baseline[path] = { hash: entry.after!.hash, size: entry.after!.size }; if (next.added) next.added = next.added.filter(item => item !== path); }
          await this.state.setPictures(next); pictureNow = next;
        };
        // Suggestion decisions come first: the reviewed edits are then sent
        // against the text they leave, which already matches the local result.
        const decided = new Map<string, DocState>();
        const decisions = operations.filter(isDecision);
        for (const [index, draft] of decisions.entries()) {
          progress(`Sending suggestion decision ${index + 1} of ${decisions.length}…`); await this.checkLocal(plan, valid);
          const reviewed = plan.inspection.docs.find(doc => doc.docId === draft.docId);
          if (!reviewed) throw new SyncError('A suggestion\'s file changed identity. Discard the decision and review again.', 'stale');
          const expected = decided.get(draft.docId) ?? reviewed, before = await session.rejoin(reviewed); written.add(draft.docId);
          if (before.version !== expected.version || before.text !== expected.text) throw new SyncError(`${draft.path} changed on Overleaf. Get latest again.`, 'stale');
          const found = findSuggestion(before, draft.change!);
          if (found < 0) throw new SyncError(`${draft.path}: a suggestion was decided on Overleaf meanwhile. Get latest and review again.`, 'stale');
          const suggestion = before.changes[found];
          await this.checkLocal(plan, valid);
          await guardedWrite(this.state, { kind: draft.kind, projectId: this.projectId, path: draft.path, docId: draft.docId, version: before.version, change: draft.change }, valid, async () => true, async permit => {
            await fence(draftStep(draft)); await reader.write(permit, session);
          }, output);
          const after = await session.rejoin(reviewed);
          if (after.text !== visibleAfter(before.text, suggestion, decisionOf(draft)) || countSuggestion(after, draft.change!) !== countSuggestion(before, draft.change!) - 1) throw new SyncError(`${draft.path}: the suggestion decision could not be verified. Inspect Sync history before retrying.`, 'verification');
          decided.set(draft.docId, after);
          sent.comments[draft.id] = { kind: draft.kind, threadId: '', docId: draft.docId };
          history.completed.push(draftStep(draft)); attempted = undefined;
          await this.state.writeHistory(history);
        }
        // Pictures before the text: a figure is on Overleaf before the source that uses it.
        for (const picture of pictures) await sendPicture(picture);
        for (const file of plan.files) {
          if (file.create) { await createFile(file); continue; }
          if (file.remove) { await removeFile(file); continue; }
          progress(`Sending ${file.doc.path}…`); await this.checkLocal(plan, valid);
          const expected = decided.get(file.doc.docId) ?? file.doc, before = await session.rejoin(file.doc); written.add(file.doc.docId);
          if (before.version !== expected.version || before.text !== expected.text) throw new SyncError(`${file.doc.path} changed on Overleaf. Get latest again.`, 'stale');
          // Rejections alone may already have produced the reviewed text.
          if (before.text === file.text) { history.completed.push(`file:${file.doc.path}`); continue; }
          await this.checkLocal(plan, valid);
          // The reviewed diff is sent as one versioned edit, not a whole-file upload.
          await guardedWrite(this.state, { kind: 'edit', projectId: this.projectId, path: file.doc.path, docId: file.doc.docId, bytes: file.bytes, version: before.version }, valid, async () => true, async permit => {
            await fence(`file:${file.doc.path}`); await reader.write(permit, session);
          }, output);
          const after = await session.rejoin(file.doc);
          history.observed ??= { time: new Date().toISOString(), files: {}, comments: {} };
          history.observed.files[file.doc.path] = after.text; history.observed.time = new Date().toISOString();
          // Another client's update carries its operation; the server's
          // acknowledgement of this edit does not.
          const foreign = session.socket.updates.filter(event => event.doc === file.doc.docId && event.v >= before.version && 'op' in event);
          if (after.text !== file.text) throw new SyncError(foreign.length
            ? `${file.doc.path}: a collaborator edited at the same moment. Overleaf kept both edits; Get latest to bring theirs in before sending again.`
            : `${file.doc.path}: the result on Overleaf differs from the reviewed content. Inspect Sync history before retrying.`, 'verification');
          for (const event of foreign) history.warnings.push(`${file.doc.path}: a collaborator's edit at version ${event.v} was merged with yours. Inspect Overleaf history.`);
          // With Track Changes on the edit arrived as suggestions; undo rejects exactly these.
          const known = before.changes.map(suggestionRef), user = plan.inspection.userId;
          sent.files[file.doc.path] = { suggestions: after.changes.map(suggestionRef).filter(change => (!user || change.authorId === user || change.author === user) && !known.some(old => sameSuggestion(old, change))),
            lostComments: file.mapping.comments.filter(anchor => ['edited locally', 'deleted locally'].includes(anchor.label)).length, lostSuggestions: file.mapping.affectedSuggestions.length };
          history.completed.push(`file:${file.doc.path}`); attempted = undefined;
          await this.state.writeHistory(history);
        }
        let current = plan.files.length || decisions.length ? await check() : session.inspection;
        // File uploads may move anchors. Message/state changes must still match
        // what was reviewed before any queued comment mutation is attempted.
        const expected = structuredClone(plan.inspection.threads), comments = operations.filter(draft => !isDecision(draft));
        for (const [index, draft] of comments.entries()) {
          progress(`Sending comment ${index + 1} of ${comments.length}…`);
          await this.checkLocal(plan, valid);
          // Comments, plus only the documents that were edited since the last read.
          current = await read({ docs: 'changed' });
          if (current.docs.some(doc => doc.text !== wanted[doc.path])) throw new SyncError('Overleaf source changed before the comment action. Get latest and review again.', 'stale');
          if (fingerprint(current.threads[draft.threadId]) !== fingerprint(expected[draft.threadId])) throw new SyncError('A comment changed while sending. Review the latest thread before continuing.', 'stale');
          validateDraft({ ...draft, before: expected[draft.threadId] }, current, plan.saved, operations);
          const prior = current.threads[draft.threadId];
          await this.checkLocal(plan, valid);
          await guardedWrite(this.state, { kind: draft.kind, projectId: this.projectId, path: draft.path, docId: draft.docId, threadId: draft.threadId, messageId: draft.messageId, text: draft.text, anchor: draft.anchor }, valid, async () => true, async permit => {
            await fence(draftStep(draft)); await reader.write(permit, session);
          }, output);
          current = await read({ docs: 'changed' });
          history.observed = { time: current.fetchedAt, files: remoteTexts(current), comments: current.threads };
          const created = verifyComment(draft, prior, current);
          sent.comments[draft.id] = { kind: draft.kind, threadId: draft.threadId, docId: draft.docId, ...(draft.messageId ?? created) && { messageId: draft.messageId ?? created } };
          expected[draft.threadId] = current.threads[draft.threadId];
          history.completed.push(draftStep(draft)); attempted = undefined;
          await this.state.writeHistory(history);
        }
        // The live connection's tree changes only on reconnect: pictures need a fresh one.
        const fresh = pictures.length ? { ...await check(), tree: await reader.projectTree(this.projectId) } : await check();
        history.observed = { time: fresh.fetchedAt, files: remoteTexts(fresh), comments: fresh.threads };
        if (fingerprint(fresh.threads) !== fingerprint(expected)) throw new SyncError('Comments changed during Send. Get latest to review the incoming comments; completed actions are recorded in Sync history.', 'stale');
        const mismatches = this.paths.filter(path => wanted[path] !== remoteTexts(fresh)[path]);
        if (mismatches.length) throw new SyncError(`Remote verification differs for ${mismatches.join(', ')}. Get latest before sending again.`, 'verification');
        await this.checkLocal(plan, valid);
        // Rejected suggestions change the local files too, journaled like Apply.
        const rejected = this.paths.filter(path => plan.local[path] !== plan.saved[path]);
        if (rejected.length) {
          await this.state.update(data => { data.localApply = { history: history.id, before: plan.saved, after: plan.local }; });
          for (const path of rejected) { await replaceSaved(this.root, path, plan.saved[path], plan.local[path], valid); history.completed.push(`local:${path}`); }
          if (!sameSaved(await readSaved(this.root, this.paths, true), plan.local)) throw new SyncError('The local source changed while applying rejected suggestions.', 'stale');
        }
        const revision = randomUUID();
        await this.state.update(data => {
          data.acknowledged = fresh; data.observed = fresh; data.revision = revision;
          data.pending = data.pending.filter(draft => !operations.some(done => done.id === draft.id)); delete data.partialSend; delete data.localApply;
        });
        history.outcome = 'success'; history.finished = new Date().toISOString(); await this.state.writeHistory(history);
        if (plan.undoOf) {
          const [original] = await this.state.history(plan.undoOf);
          if (original) { original.undoneBy = history.id; await this.state.writeHistory(original); }
        }
        return { inspection: fresh, snapshot: revision, mismatches, warnings: history.warnings, history: history.id };
      } catch (error) {
        const touched = attempted || history.completed.length;
        if (touched) await this.state.update(data => {
          data.partialSend = { history: history.id, confirmed: [...history.completed], uncertain: attempted ? [attempted] : [] };
          if (attempted && !attempted.startsWith('file:')) data.pending = data.pending.map(draft => draftStep(draft) === attempted ? { ...draft, uncertain: true } : draft);
        });
        history.outcome = attempted ? 'uncertain' : history.completed.length ? 'partial' : error instanceof SyncError && error.code === 'stale' ? 'stale' : 'failed';
        history.error = safeError(error); history.finished = new Date().toISOString(); await this.state.writeHistory(history);
        throw new SyncError(`${safeError(error)}${touched ? '\nSome changes may already be remote. Get latest and inspect Sync history; uncertain comment drafts are never resent automatically.' : ''}`, error instanceof SyncError ? error.code : 'sync', undefined, error);
      } finally { stopTree?.(); if (session && session !== live) await session.close(); }
    });
  }
}

function validateDraft(draft: CommentDraft, remote: Inspection, saved: SavedTexts, pending: CommentDraft[]): void {
  if (draft.uncertain) throw new SyncError(`A ${isDecision(draft) ? 'suggestion decision' : 'comment draft'} has an uncertain earlier outcome. Inspect Sync history and discard it after reconciling with Overleaf.`, 'recovery');
  if (isDecision(draft)) return;
  const doc = remote.docs.find(doc => doc.path === draft.path && doc.docId === draft.docId), thread = remote.threads[draft.threadId];
  if (!doc) throw new SyncError('A comment source file changed identity. Recreate the draft against the current file.', 'stale');
  if (draft.kind === 'createThread') {
    if (thread || !draft.anchor || draft.anchor.source !== saved[draft.path]) throw new SyncError(thread ? 'This new comment already exists on Overleaf. Discard the draft.' : `The text a new comment was on changed in ${draft.path}. Select the text again in the editor, then choose Update selection on the comment marked Blocks Send.`, 'stale');
    return;
  }
  if (!thread) {
    if (['reply', 'resolve', 'reopen'].includes(draft.kind) && pending.some(parent => parent.kind === 'createThread' && parent.threadId === draft.threadId)) return;
    throw new SyncError('This thread was removed on Overleaf. Preserve or discard its pending draft.', 'stale');
  }
  if (draft.kind === 'editMessage' || draft.kind === 'deleteMessage') {
    const current = thread.messages.find(message => message.id === draft.messageId), before = draft.before?.messages.find(message => message.id === draft.messageId);
    if (!current?.authorId || current.authorId !== remote.userId) throw new SyncError('Only your own messages can be edited or deleted.', 'read-only');
    if (!before || current.text !== before.text) throw new SyncError('The remote message differs from this draft. Get latest, then revise or discard the draft.', 'stale');
  } else if (draft.kind !== 'reply' && fingerprint(thread) !== fingerprint(draft.before)) throw new SyncError('The thread changed after this draft was made. Get latest, then revise or discard it.', 'stale');
}
/** Throws unless Overleaf shows the change. Returns the ID of the message a reply or new comment created. */
function verifyComment(draft: CommentDraft, before: Thread | undefined, fresh: Inspection): string | undefined {
  const thread = fresh.threads[draft.threadId];
  const message = thread?.messages.find(message => message.id === draft.messageId);
  const created = thread?.messages.find(message => message.text === draft.text && message.authorId === fresh.userId && !before?.messages.some(old => old.id === message.id));
  const ok = draft.kind === 'deleteThread' ? !thread : draft.kind === 'deleteMessage' ? !!thread && !message
    : draft.kind === 'editMessage' ? message?.text === draft.text
    : draft.kind === 'resolve' || draft.kind === 'reopen' ? thread?.resolved === (draft.kind === 'resolve')
    : !!created;
  if (!ok) throw new SyncError('The comment change could not be verified. Inspect Sync history before retrying.', 'verification');
  return draft.kind === 'reply' || draft.kind === 'createThread' ? created?.id : undefined;
}

export class ReviewWorkflow {
  constructor(readonly sync: SyncService) {}
  /** Stops that need no look at Overleaf: an interrupted Apply or Send, or no baseline yet. */
  private precheck(data: ProjectData): void {
    if (data.localApply) throw blocked('recover', 'Recover the interrupted local Apply first.', 'recovery');
    if (data.partialSend) throw blocked('getLatest', 'Get latest to review the interrupted send before continuing.', 'incoming');
    if (!data.acknowledged) throw blocked('getLatest', 'Get latest to establish the local sync baseline.', 'incoming');
  }
  async prepareSend(): Promise<PushPlan> {
    const s = this.sync;
    return s.state.exclusive(async () => {
      await new LocalReviewFiles(s.state).importEdits();
      await s.state.followSelections(await readSaved(s.root, s.paths, true));
      const data = await s.state.read();
      this.precheck(data);
      const fresh = await this.withTree(await s.fetchPull()), saved = await readSaved(s.root, s.paths, true);
      // Recorded even when the plan is blocked, so the summary can name the reason.
      await s.saveRefresh(fresh);
      return this.buildSend(data, fresh, saved);
    });
  }
  /**
   * What Send would write for this stored state, Overleaf state and saved files,
   * or why it cannot send and the way out. Makes no request to Overleaf: the
   * standing summary calls it with the last observed Overleaf state.
   */
  async planSend(data: ProjectData, overleaf: Inspection, saved: SavedTexts): Promise<SendPlan> {
    try { return { plan: await this.buildSend(data, overleaf, saved) }; }
    catch (error) {
      if (error instanceof Blocked) return { blocked: error.block };
      if (error instanceof SyncError) return { blocked: { way: 'fix', message: error.message, code: error.code } };
      throw error;
    }
  }
  /**
   * `fresh` with a project tree read now when pictures may go out (some tracked or
   * added): the live connection's tree changes only on reconnect. Send checks each
   * picture on a fresh tree again right before writing it.
   */
  private async withTree(fresh: Inspection): Promise<Inspection> {
    const s = this.sync;
    if (!s.state.syncPictures()) return fresh;
    const state = await s.state.pictures();
    return Object.keys(state.baseline).length || state.added?.length ? { ...fresh, tree: await (await s.remote()).projectTree(s.projectId) } : fresh;
  }
  private async buildSend(data: ProjectData, fresh: Inspection, saved: SavedTexts): Promise<PushPlan> {
    const s = this.sync;
    this.precheck(data);
    const remoteAbsent = absentOnOverleaf(data.acknowledged, fresh, saved);
    if (remoteAbsent.problem) throw blocked('fix', remoteAbsent.problem, 'missing');
    const absent = s.paths.filter(path => (saved[path] === null || saved[path] === undefined) && !fresh.missingFiles.includes(path));
    if (absent.length) throw blocked('getLatest', `${absent.join(', ')} ${absent.length === 1 ? 'is' : 'are'} missing in the local folder. Get latest restores ${absent.length === 1 ? 'it' : 'them'} from Overleaf.`, 'incoming');
    let incoming: PullPlan | undefined, target: SavedTexts = saved;
    const files: PushFile[] = [];
    if (!sameContent(data.acknowledged!, fresh)) {
      incoming = await this.pullPlan(data, fresh, saved);
      const conflicts = incoming.files.filter(file => file.conflict);
      if (conflicts.length) throw blocked('getLatest', `${conflicts.map(file => file.firstSync ? `${file.path} (not synchronized before)` : `${file.path} (near line ${file.conflictLine ?? 1})`).join(', ')} also changed on Overleaf where you edited. Get latest to resolve, then review again.`, 'incoming');
      const moved = data.pending.find(draft => draft.kind === 'createThread' && incoming!.files.some(file => file.path === draft.path));
      if (moved) throw blocked('getLatest', `${moved.path} changed on Overleaf and has a new comment waiting. Get latest first; the comment then follows its text.`, 'incoming');
      target = incoming.proposed;
    }
    for (const draft of data.pending) {
      try { validateDraft(draft, fresh, saved, data.pending); }
      catch (error) { throw error instanceof SyncError ? blocked('draft', error.message, error.code, draft.id) : error; }
    }
    // Each decided suggestion must still be on Overleaf; rejections apply to the local text as well.
    const local: SavedTexts = { ...target };
    for (const doc of fresh.docs) {
      const decided = data.pending.filter(draft => isDecision(draft) && draft.docId === doc.docId).map(draft => {
        const index = findSuggestion(doc, draft.change!);
        if (index < 0) throw blocked('draft', `${doc.path}: a suggestion you decided was changed or decided on Overleaf. Discard that decision, then review again.`, 'stale', draft.id);
        return { suggestion: doc.changes[index], decision: decisionOf(draft), draft };
      });
      const twice = decided.find((d, n) => decided.findIndex(other => other.suggestion.id === d.suggestion.id) !== n);
      if (twice) throw blocked('draft', `${doc.path}: two decisions concern the same suggestion. Discard one, then review again.`, 'stale', twice.draft.id);
      if (decided.length) local[doc.path] = rejectLocally(doc.path, doc.text, target[doc.path]!, decided.filter(d => d.decision === 'reject').map(d => d.suggestion));
      const bytes = Buffer.from(local[doc.path]!), text = validateUpload(doc.path, bytes);
      if (text !== doc.text) {
        const diff = diffText(doc.text, text), mapping = mapDocument(doc, text, fresh.trackChanges, diff.diffs);
        // A decided suggestion is not edited by the send that decides it.
        mapping.affectedSuggestions = mapping.affectedSuggestions.filter(item => !decided.some(d => d.suggestion.id === item.suggestion.id));
        files.push({ doc, bytes, text, mapping, ...changedLines(diff.diffs) });
      }
    }
    for (const path of remoteAbsent.created) {
      const bytes = Buffer.from(local[path]!), text = validateUpload(path, bytes), diff = diffText('', text);
      const doc: DocState = { path, docId: '', otType: 'sharejs-text-ot', version: 0, text: '', comments: [], changes: [], diagnostics: [] };
      // Folders known from the last read; Send checks a fresh project tree.
      files.push({ doc, bytes, text, mapping: mapDocument(doc, text, false, diff.diffs), ...changedLines(diff.diffs), create: { folders: fresh.tree ? missingFolders(path, fresh.tree.folders) : [] } });
    }
    const pictureBase = s.state.syncPictures() ? await s.state.pictures() : undefined;
    const pictures = pictureBase ? await planOutgoing(s.root, fresh, pictureBase) : undefined;
    return { inspection: fresh, cache: await s.state.cache(), saved, revision: data.revision, pending: data.pending, files, comments: outgoingComments(fresh, data.pending), incoming, local, ...pictureBase && { pictures, pictureBase } };
  }
  /** A fresh read of Overleaf, then the plan that takes the Send record `id` back. Throws when it cannot be undone now. */
  async prepareUndo(id: string): Promise<UndoPlan> {
    const s = this.sync;
    return s.state.exclusive(async () => {
      await new LocalReviewFiles(s.state).importEdits();
      const data = await s.state.read(), [record] = await s.state.history(id);
      const fresh = await this.withTree(await s.fetchPull()), saved = await readSaved(s.root, s.paths, true);
      await s.saveRefresh(fresh);
      const result = await this.planUndo(record, data, fresh, saved);
      if (result.blocked) throw new Blocked(result.blocked);
      return result.plan;
    });
  }
  /**
   * Undo this send: the reverse of one successful Send, written to Overleaf only.
   * Local files and queued drafts stay; the edits are listed as going out again
   * afterwards. Per file a three-way merge with the sent text as the common
   * version, so later edits elsewhere stay and an overlap leaves the file as sent.
   * Makes no request to Overleaf.
   */
  async planUndo(record: SyncHistory | undefined, data: ProjectData, fresh: Inspection, saved: SavedTexts): Promise<{ plan: UndoPlan; blocked?: undefined } | { plan?: undefined; blocked: SendBlock }> {
    const s = this.sync, stop = (way: SendBlock['way'], message: string, code: string) => ({ blocked: { way, message, code } });
    if (!record || record.direction !== 'send' || record.outcome !== 'success' || record.project !== s.projectId) return stop('fix', 'This Send is not in Sync history any more, so it cannot be undone.', 'cache');
    if (record.undoOf) return stop('fix', 'An undo is not undone. Your local files still hold the edits: Send puts them back on Overleaf.', 'configuration');
    if (record.undoneBy) return stop('fix', 'This Send was already undone.', 'configuration');
    try { this.precheck(data); }
    catch (error) { if (error instanceof Blocked) return { blocked: error.block }; throw error; }
    // Send moves the sync baseline to Overleaf's state. Changes not applied locally
    // yet would then look like local edits that remove them.
    if (!sameContent(data.acknowledged!, fresh)) return stop('getLatest', 'Overleaf changed since your last sync. Get latest and apply, then undo.', 'incoming');
    const info = sentInfo(record, fresh.userId), created = record.finished ?? record.time;
    const stays: UndoRow[] = [], taken: UndoPlan['files'] = [], files: PushFile[] = [], operations: CommentDraft[] = [];
    const remote: SavedTexts = remoteTexts(fresh);
    const decisions = record.comments.filter(change => change.suggestion);
    for (const change of decisions) stays.push({ key: `comment:${change.id}`, label: change.label, path: change.path, reason: 'The suggestion no longer exists as a suggestion.' });
    for (const file of record.files) {
      const key = `file:${file.path}`, doc = fresh.docs.find(doc => doc.path === file.path);
      const stay = (reason: string) => { stays.push({ key, label: file.path, path: file.path, reason }); };
      const made = record.sent?.created?.[file.path];
      if (made?.docId && s.paths.includes(file.path)) {
        // A file this Send created is deleted again, only while it is as sent.
        if (!doc) continue;
        if (doc.docId !== made.docId) { stay('A different file with this name is on Overleaf now.'); continue; }
        if (doc.text !== file.after) { stay('Edited on Overleaf since this Send. Delete it on Overleaf by hand if it should go.'); continue; }
        if (doc.comments.length || doc.changes.length) { stay('It has comments or suggestions on Overleaf now. Delete it on Overleaf by hand if it should go.'); continue; }
        const diff = diffText(doc.text, '');
        files.push({ doc, bytes: Buffer.alloc(0), text: '', mapping: mapDocument(doc, '', fresh.trackChanges, diff.diffs), ...changedLines(diff.diffs), remove: { docId: made.docId!, folders: made.folders } });
        delete remote[doc.path];
        taken.push({ path: doc.path, ...changedLines(diff.diffs), note: `Deletes this file from Overleaf, which this Send created${made.folders.length ? `; the folder ${made.folders.map(folder => folder.path).join(', ')} that it created stays` : ''}. Overleaf keeps deleted files restorable in its history.` });
        continue;
      }
      if (!doc) { stay('This file is no longer selected for sync.'); continue; }
      if (decisions.some(change => change.path === file.path)) { stay('Sent together with a suggestion decision in this file, which cannot be taken back.'); continue; }
      const merged = await mergeSaved(file.after, file.before, doc.text);
      if (merged.conflict) { stay(`Edited on Overleaf at the same place since (near line ${merged.line ?? 1}). The text before this Send opens from the record in Sync history.`); continue; }
      if (merged.text === doc.text) continue;
      const entry = info.files[file.path], detail = isSentPicture(entry) ? undefined : entry, start = new Date(record.time).getTime() - 2000, end = new Date(record.finished ?? record.time).getTime() + 2000;
      // A record without details: your suggestions dated within the Send show it was tracked.
      const tracked = detail ? detail.suggestions.length > 0 : doc.changes.some(change => (!fresh.userId || change.authorId === fresh.userId) && change.timestamp !== undefined && new Date(change.timestamp).getTime() >= start && new Date(change.timestamp).getTime() <= end);
      let note: string | undefined, rejected: string[] = [];
      if (tracked) {
        if (!detail) { stay('Sent as suggestions (Track Changes on) before the extension recorded them. Reject them on Overleaf instead.'); continue; }
        const found = detail.suggestions.map(ref => findSuggestion(doc, ref));
        let text: string | undefined;
        if (found.every(index => index >= 0) && new Set(found).size === found.length) try { text = rejectLocally(doc.path, doc.text, doc.text, found.map(index => doc.changes[index])); } catch { /* stays */ }
        if (text !== merged.text) { stay('The suggestions this Send made were changed or decided on Overleaf since.'); continue; }
        found.forEach((index, n) => operations.push({ id: `${record.id}:undo:suggestion:${file.path}:${n}`, kind: 'rejectChange', path: doc.path, docId: doc.docId, threadId: '', change: suggestionRef(doc.changes[index]), created }));
        rejected = found.map(index => doc.changes[index].id);
        note = `Rejects the ${count(found.length, 'suggestion', 'suggestions')} this Send made.`;
      } else if (fresh.trackChanges) note = 'Track Changes is on now: the reversal appears on Overleaf as your suggestions.';
      const bytes = Buffer.from(merged.text), text = validateUpload(doc.path, bytes), diff = diffText(doc.text, text);
      // What taking the text back detaches now, e.g. a comment a coauthor made on it since. The Send's own suggestions are the undo itself.
      const mapping = mapDocument(doc, text, fresh.trackChanges, diff.diffs);
      mapping.affectedSuggestions = mapping.affectedSuggestions.filter(item => !rejected.includes(item.suggestion.id));
      const mark = lostText(mapping);
      files.push({ doc, bytes, text, mapping, ...changedLines(diff.diffs) });
      remote[doc.path] = text;
      taken.push({ path: doc.path, ...changedLines(diff.diffs), ...note && { note }, ...mark && { mark } });
      const lost = (detail?.lostComments ?? 0) + (detail?.lostSuggestions ?? 0);
      if (lost) stays.push({ key: `${key}:attached`, label: `${count(lost, 'comment or suggestion', 'comments or suggestions')} on text this Send replaced`, path: doc.path, reason: 'The text returns; what was attached to it does not.' });
    }
    // Pictures: a replaced one goes back while Overleaf has what this Send wrote, a created one is deleted while its ID and hash are unchanged.
    const pictures: OutgoingPicture[] = [];
    for (const [path, entry] of Object.entries(info.files)) {
      if (!isSentPicture(entry)) continue;
      const key = `picture:${path}`, stay = (reason: string) => { stays.push({ key, label: path, path, reason }); };
      const kept = record.pictures?.find(item => item.path === path), file = fresh.tree?.fileRefs?.[path], made = record.sent?.created?.[path];
      if (!s.state.syncPictures()) { stay('Pictures are not synchronized now (turnleaf.syncPictures is off).'); continue; }
      if (!file || has(fresh.tree?.docs, path)) { stay('No longer on Overleaf as this Send left it.'); continue; }
      if (file.hash !== entry.sentHash || file.linked) { stay('Replaced or changed on Overleaf since this Send.'); continue; }
      const remote = { id: file.id, hash: entry.sentHash, ...kept?.after && { size: kept.after.size } };
      if (made?.fileId) {
        if (file.id !== made.fileId) { stay('A different file with this name is on Overleaf now.'); continue; }
        pictures.push({ path, kind: 'delete', remote, note: `Deletes this picture from Overleaf, which this Send created${made.folders.length ? `; the folder ${made.folders.map(folder => folder.path).join(', ')} that it created stays` : ''}.` });
        continue;
      }
      if (!entry.replacedHash) { stay('This record does not hold what is needed to take it back.'); continue; }
      const stored = await s.state.getBytes(entry.replacedHash).catch(() => undefined);
      pictures.push({ path, kind: 'restore', hash: entry.replacedHash, ...kept?.before && { size: kept.before.size }, remote,
        ...!stored && { note: 'The replaced copy is no longer in Sync history; Undo downloads it from Overleaf by its hash.' } });
    }
    // Comment changes, last first: a reply is removed before its thread's state is put back.
    const kind = (change: CommentChange) => info.comments[change.id]?.kind ?? kindOf[change.label];
    const madeThreads = new Set(record.comments.filter(change => kind(change) === 'createThread').map(change => change.threadId));
    const threads = structuredClone(fresh.threads);
    for (const change of [...record.comments].reverse()) {
      if (change.suggestion) continue;
      const what = kind(change), id = change.threadId ?? '', key = `comment:${change.id}`;
      const stay = (reason: string) => { stays.push({ key, label: change.label, path: change.path, reason }); };
      if (what === 'deleteThread' || what === 'deleteMessage') { stay('A recreated message would be a new one written now, not the original.'); continue; }
      const sentThread = record.observed?.comments[id], now = fresh.threads[id], doc = fresh.docs.find(doc => doc.path === change.path);
      if (!what || !sentThread || !doc) { stay('This record does not hold what is needed to take it back.'); continue; }
      if (!now) { stay('The thread was removed on Overleaf since.'); continue; }
      if (fingerprint(now) !== fingerprint(sentThread)) { stay('The thread was answered or changed on Overleaf since.'); continue; }
      // Replies and state changes on a thread this Send made go with the thread.
      if (madeThreads.has(id) && what !== 'createThread') continue;
      const base = { id: `${record.id}:undo:${change.id}`, path: change.path, docId: doc.docId, threadId: id, created, before: structuredClone(threads[id]) };
      const messageId = info.comments[change.id]?.messageId;
      // A coauthor's answer can arrive in the moment of the Send's read-back and be part of the recorded thread.
      const written = new Set(record.comments.filter(other => other.threadId === id).map(other => info.comments[other.id]?.messageId));
      if (what === 'createThread' && !now.messages.every(message => message.id && written.has(message.id))) { stay('The thread holds a message this Send did not write.'); continue; }
      let operation: CommentDraft | undefined;
      if (what === 'createThread') operation = { ...base, kind: 'deleteThread' };
      else if (what === 'resolve' || what === 'reopen') operation = { ...base, kind: what === 'resolve' ? 'reopen' : 'resolve' };
      else if (what === 'reply' && messageId && now.messages.some(message => message.id === messageId && message.authorId && message.authorId === fresh.userId)) operation = { ...base, kind: 'deleteMessage', messageId };
      else if (what === 'editMessage' && messageId) {
        const old = change.before?.messages.find(message => message.id === messageId)?.text;
        if (old !== undefined && now.messages.some(message => message.id === messageId && message.authorId && message.authorId === fresh.userId)) operation = { ...base, kind: 'editMessage', messageId, text: old };
      }
      if (!operation) { stay('The message this Send wrote cannot be identified on Overleaf.'); continue; }
      operations.push(operation);
      const next = draftThread(threads[id], operation, fresh.userId);
      if (next) threads[id] = next; else delete threads[id];
    }
    const plan: PushPlan = { inspection: fresh, cache: await s.state.cache(), saved, revision: data.revision, pending: data.pending, files, comments: outgoingComments(fresh, operations), local: saved, remote, operations, undoOf: record.id,
      ...s.state.syncPictures() && { pictures, pictureBase: await s.state.pictures() } };
    return { plan: { record: record.id, time: record.time, plan, files: taken, stays } };
  }
  /** The plan for sending after `plan.incoming` was applied with the given result. */
  afterIncoming(plan: PushPlan, applied: { snapshot: string }): PushPlan {
    if (!plan.incoming) return plan;
    return { ...plan, saved: plan.incoming.proposed, revision: applied.snapshot, incoming: undefined };
  }
  async preparePull(): Promise<PullPlan> {
    const s = this.sync;
    return s.state.exclusive(async () => {
      await new LocalReviewFiles(s.state).importEdits();
      const data = await s.state.read();
      if (data.localApply) throw new SyncError('Recover the interrupted local Apply first.', 'recovery');
      const fresh = await s.fetchPull(), plan = await this.pullPlan(data, fresh, await readSaved(s.root, s.paths, true));
      await s.saveRefresh(fresh);
      if (s.state.syncPictures()) await this.addPictures(plan);
      return plan;
    });
  }
  /**
   * Plans the pictures of a Get latest preview and downloads Overleaf's copy of
   * each one Apply writes or the user compares, into the project's download
   * folder by hash. Each download is checked against the tree's hash.
   */
  private async addPictures(plan: PullPlan): Promise<void> {
    const s = this.sync, base = await s.state.pictures(), planned = await planPictures(s.root, plan.inspection, base);
    const folder = await s.state.picturePath('downloads'), wanted = new Set<string>();
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const reader = planned.pictures.some(needsDownload) ? await s.remote() : undefined;
    for (const picture of planned.pictures) {
      if (!needsDownload(picture) || !picture.remote) continue;
      checkCancelled(); progress(`Downloading ${picture.path}…`);
      const name = `${picture.remote.hash}${picture.path.slice(picture.path.lastIndexOf('.')).toLowerCase()}`, target = await s.state.picturePath(`downloads/${name}`);
      let bytes: Buffer | undefined;
      try { bytes = await readFile(target); if (gitBlobSha1(bytes) !== picture.remote.hash) bytes = undefined; } catch { /* download below */ }
      if (!bytes) {
        bytes = await reader!.downloadFile(plan.inspection.projectId, picture.path, picture.remote, plan.inspection.maxUploadSize ?? defaultUploadLimit);
        const temp = `${target}.${randomUUID()}.tmp`;
        await writeFile(temp, bytes, { mode: 0o600 }); await rename(temp, target);
      }
      picture.remote.size = bytes.length; picture.download = target; wanted.add(name);
      if (planned.next.baseline[picture.path]?.hash === picture.remote.hash) planned.next.baseline[picture.path].size = bytes.length;
    }
    // Downloads of earlier previews that this one does not use.
    for (const name of await readdir(folder)) if (!wanted.has(name)) await rm(`${folder}/${name}`, { force: true });
    Object.assign(plan, { pictures: planned.pictures, pictureLocal: planned.local, pictureBase: base, pictureNext: planned.next });
  }
  /** Use Overleaf version ('remote') or Keep my version ('local') for a picture changed on both sides. */
  choosePicture(plan: PullPlan, path: string, side: 'remote' | 'local'): PullPlan {
    if (!plan.pictures?.some(picture => picture.path === path && picture.kind === 'both')) throw new SyncError('This picture has no pending choice.', 'configuration');
    return { ...plan, pictures: plan.pictures.map(picture => picture.path === path ? { ...picture, choice: side, note: side === 'remote' ? 'Overleaf version used. Your copy stays in Sync history.' : 'Your version kept. Overleaf\'s copy is not changed.' } : picture) };
  }
  private async pullPlan(data: ProjectData, fresh: Inspection, saved: SavedTexts): Promise<PullPlan> {
    const s = this.sync, proposed = { ...saved }, files: IncomingFile[] = [];
    // A file only local and never synchronized brings nothing in; Send creates it.
    const absent = absentOnOverleaf(withoutUndoDeletions(data), fresh, saved);
    if (absent.problem) throw new SyncError(absent.problem, 'missing');
    {
      for (const doc of fresh.docs) {
        const known = data.acknowledged?.docs.find(old => old.path === doc.path)?.text, before = saved[doc.path] ?? '';
        const merge: { text: string; conflict: boolean; line?: number } = saved[doc.path] === null ? { text: doc.text, conflict: false }
          : known === undefined ? { text: before === doc.text ? before : mergeConflict(before, undefined, doc.text), conflict: before !== doc.text }
          : await mergeSaved(known, before, doc.text);
        proposed[doc.path] = merge.text;
        if (saved[doc.path] === null || before !== merge.text || merge.conflict) files.push({ path: doc.path, before, after: merge.text, base: known ?? '', remote: doc.text, conflict: merge.conflict, ...changedLines(diffText(before, merge.text).diffs), ...known === undefined && merge.conflict && { firstSync: true }, ...merge.line !== undefined && { conflictLine: merge.line } });
      }
    }
    return { inspection: fresh, cache: await s.state.cache(), saved, proposed, files, revision: data.revision, pending: data.pending, comments: incomingComments(data.acknowledged, fresh) };
  }
  resolve(plan: PullPlan, path: string, text: string): PullPlan {
    if (!plan.files.some(file => file.path === path && file.conflict)) throw new SyncError('This file has no pending conflict.', 'configuration');
    if (/^(<{7}|\|{7}|={7}|>{7})(?: |$)/m.test(text)) throw new SyncError('Remove every conflict marker before using this resolution.', 'conflict');
    validateUpload(path, Buffer.from(text));
    return { ...plan, proposed: { ...plan.proposed, [path]: text }, files: plan.files.map(file => file.path === path ? { ...file, after: text, conflict: false, ...changedLines(diffText(file.before, text).diffs) } : file) };
  }
  async apply(plan: PullPlan, valid: () => boolean): Promise<{ snapshot: string; checkpoint: string }> {
    const s = this.sync;
    return s.state.exclusive(async () => {
      const pictures = plan.pictures ?? [], writes = pictures.filter(writesPicture);
      const history = s.state.newHistory('pull', plan.files.map(file => ({ path: file.path, before: file.before, after: file.after })), plan.comments);
      const size = (value?: { hash?: string; size?: number } | null) => value?.hash && value.size !== undefined ? { hash: value.hash, size: value.size } : null;
      if (pictures.length) history.pictures = pictures.filter(picture => writesPicture(picture) || picture.kind === 'deleted' || picture.kind === 'both')
        .map(picture => ({ path: picture.path, kind: picture.kind === 'both' ? `both-${picture.choice ?? 'open'}` : picture.kind, before: size(picture.local), after: writesPicture(picture) ? size(picture.remote) : size(picture.local) }));
      history.checkpoint = history.id; await s.state.writeHistory(history);
      let journaled = false;
      try {
        if (plan.files.some(file => file.conflict) || pictures.some(pictureConflict)) throw new SyncError('Resolve every file conflict before applying.', 'conflict');
        if ((await s.state.read()).localApply) throw new SyncError('Recover the interrupted local Apply first.', 'recovery');
        await s.checkLocal(plan, valid); await this.checkPictures(plan, valid);
        const fresh = await s.fetchPull();
        if (!sameRemote(plan.inspection, fresh) || plan.pictures && !samePictures(plan.inspection, fresh)) throw new SyncError('Overleaf changed during review. Get latest again.', 'stale');
        await s.checkLocal(plan, valid); await this.checkPictures(plan, valid); checkCancelled();
        // Overleaf's verified bytes, and every local copy Apply overwrites kept in Sync history first.
        const incoming = new Map<string, Buffer>();
        for (const picture of writes) {
          const bytes = picture.download ? await readFile(picture.download).catch(() => undefined) : undefined;
          if (!bytes || gitBlobSha1(bytes) !== picture.remote!.hash) throw new SyncError(`${picture.path}: the downloaded copy is missing or changed. Get latest again.`, 'stale');
          incoming.set(picture.path, bytes);
          if (picture.local?.hash) await s.state.putBytes(await readPicture(s.root, picture.path, picture.local.hash));
        }
        await s.state.update(data => { data.localApply = { history: history.id, before: plan.saved, after: plan.proposed,
          ...writes.length && { pictures: Object.fromEntries(writes.map(picture => [picture.path, { before: picture.local?.hash ?? null, after: picture.remote!.hash }])) } }; }); journaled = true;
        for (const file of plan.files) { await replaceSaved(s.root, file.path, plan.saved[file.path], plan.proposed[file.path], valid); history.completed.push(`file:${file.path}`); }
        for (const picture of writes) { await replacePicture(s.root, picture.path, picture.local?.hash ?? null, incoming.get(picture.path)!, valid); history.completed.push(`picture:${picture.path}`); }
        if (!valid() || !sameSaved(await readSaved(s.root, s.paths, true), plan.proposed)) throw new SyncError('The local source changed during Apply.', 'stale');
        for (const picture of writes) if ((await localPicture(s.root, picture.path, Infinity))?.hash !== picture.remote!.hash) throw new SyncError(`${picture.path} changed during Apply.`, 'stale');
        const revision = randomUUID();
        await s.state.update(data => {
          if (data.revision !== plan.revision || fingerprint(data.pending) !== fingerprint(plan.pending)) throw new SyncError('The local sync state changed during Apply.', 'stale');
          if (data.partialSend) {
            const { confirmed, uncertain } = data.partialSend;
            data.pending = data.pending.filter(draft => !confirmed.includes(draftStep(draft))).map(draft => uncertain.includes(draftStep(draft)) ? { ...draft, uncertain: true } : draft);
          }
          data.acknowledged = fresh; data.observed = fresh; data.revision = revision; delete data.localApply; delete data.partialSend;
        });
        // After the journal is cleared: an interrupted Apply restores the old pictures, so their old baseline must stay.
        if (plan.pictureNext) await s.state.setPictures(plan.pictureNext);
        history.completed.push(...plan.comments.map(comment => `comment:${comment.id}`)); history.outcome = 'success'; history.finished = new Date().toISOString(); await s.state.writeHistory(history);
        return { snapshot: revision, checkpoint: history.id };
      } catch (error) {
        history.outcome = journaled ? 'partial' : error instanceof SyncError && error.code === 'stale' ? 'stale' : 'failed'; history.error = safeError(error); history.finished = new Date().toISOString(); await s.state.writeHistory(history);
        throw new SyncError(`${safeError(error)}${journaled ? '\nRecover Local Apply before continuing. The before/after copies remain in local sync state.' : ''}`, journaled ? 'recovery' : error instanceof SyncError ? error.code : 'sync', undefined, error);
      }
    });
  }
  /** The picture baseline and every local picture the plan relies on are as planned. */
  private async checkPictures(plan: PullPlan, valid: () => boolean): Promise<void> {
    if (!plan.pictureLocal) return;
    const s = this.sync;
    if (fingerprint(await s.state.pictures()) !== fingerprint(plan.pictureBase)) throw new SyncError('The picture baseline changed. Review again.', 'stale');
    for (const [path, hash] of Object.entries(plan.pictureLocal)) {
      if (!valid() || ((await localPicture(s.root, path, Infinity))?.hash ?? null) !== hash) throw new SyncError(`${path}: local contents changed. Review again.`, 'stale');
    }
  }
  async recover(valid: () => boolean): Promise<string> {
    const s = this.sync;
    return s.state.exclusive(async () => {
      const data = await s.state.read(), journal = data.localApply;
      if (!journal) throw new SyncError('No interrupted local Apply needs recovery.', 'recovery');
      if (Object.keys(journal.before).sort().join('\0') !== [...s.paths].sort().join('\0') || Object.keys(journal.after).sort().join('\0') !== [...s.paths].sort().join('\0')) throw new SyncError('The recovery copies do not match the selected source files.', 'recovery');
      const current = await readSaved(s.root, s.paths, true);
      for (const path of s.paths) if (current[path] !== journal.before[path] && current[path] !== journal.after[path]) throw new SyncError(`${path} changed after the interrupted Apply. Preserve that edit before recovery.`, 'recovery');
      // Pictures go back to the bytes kept in Sync history, or are removed when Apply created them.
      const pictures: { path: string; now: string | null; bytes: Buffer | null }[] = [];
      for (const [path, entry] of Object.entries(journal.pictures ?? {})) {
        const now = (await localPicture(s.root, path, Infinity))?.hash ?? null;
        if (now === entry.before) continue;
        if (now !== entry.after) throw new SyncError(`${path} changed after the interrupted Apply. Preserve that change before recovery.`, 'recovery');
        const bytes = entry.before === null ? null : await s.state.getBytes(entry.before);
        if (bytes === undefined) throw new SyncError(`${path}: the copy kept before Apply is missing from Sync history.`, 'recovery');
        pictures.push({ path, now, bytes });
      }
      for (const path of s.paths) if (current[path] !== journal.before[path]) await replaceSaved(s.root, path, current[path], journal.before[path], valid);
      for (const picture of pictures) await replacePicture(s.root, picture.path, picture.now, picture.bytes, valid);
      await s.state.update(data => { delete data.localApply; });
      const [history] = await s.state.history(journal.history);
      if (history) { history.outcome = 'recovered'; history.finished = new Date().toISOString(); await s.state.writeHistory(history); }
      return journal.history;
    });
  }
}

export function pushReport(plan: PushPlan): string {
  return ['# Review changes to Overleaf', '', ...(plan.pictures ?? []).map(picture => `- ${picture.path}: ${outgoingSummary(picture)}${picture.note ? ` · ${picture.note}` : ''}`), ...plan.files.map(file => `- ${file.doc.path}: +${file.added} / −${file.removed}${file.create ? ` · new on Overleaf${file.create.folders.length ? `, creates folder ${file.create.folders.join(', ')}` : ''}` : file.remove ? ' · deleted from Overleaf' : ''}`), '', ...plan.comments.map(comment => comment.suggestion ? `## ${comment.label} · ${comment.path} line ${comment.suggestion.line}\n\n${comment.suggestion.kind === 'insert' ? 'Added' : 'Deleted'} by ${comment.suggestion.author}: ${comment.suggestion.text}` : `## ${comment.label} · ${comment.path}\n\nBefore:\n${comment.before?.messages.map(message => message.text).join('\n\n') ?? '(none)'}\n\nAfter:\n${comment.after?.messages.map(message => message.text).join('\n\n') ?? '(removed)'}`), '', 'Send rechecks the reviewed files and comments. A simultaneous edit inside the final upload gap can still be overwritten; inspect any concurrency warning in Sync history.'].join('\n');
}
