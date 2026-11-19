import { readFile, mkdir, writeFile, rename, readdir, lstat, unlink, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Anchor, Inspection, Thread } from './models';
import type { CommentDraft, ProjectData, ProjectStore } from './projectStore';
import { isDecision } from './projectStore';
import { anchorLabel } from './review';
import { atomicJson } from './storage';
import { readSaved } from './savedFiles';
import { SyncError } from './errors';

export interface LocalCommentEdit {
  id: string;
  action: Exclude<CommentDraft['kind'], 'acceptChange' | 'rejectChange'>;
  messageId?: string;
  text?: string;
}
interface SourceAnchor {
  path: string; documentId: string; line: number | null;
  quotedText: string; ranges: Anchor['ranges']; state: string;
}
export interface ThreadFile {
  $schema: string; schema: 1; projectKey: string; threadId: string; generation: string;
  baseline: { thread: Thread | null; anchor: SourceAnchor | null };
  remote: { thread: Thread | null; anchor: SourceAnchor | null };
  localSelection: SourceAnchor | null;
  uncertainEditIds: string[];
  localEdits: LocalCommentEdit[];
}
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const stable = (value: unknown): string => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const same = (a: unknown, b: unknown) => stable(a) === stable(b);
const editOf = (draft: CommentDraft): LocalCommentEdit => ({ id: draft.id, action: draft.kind as LocalCommentEdit['action'], ...draft.messageId && { messageId: draft.messageId }, ...draft.text !== undefined && { text: draft.text } });
const draftsFor = (data: ProjectData, id: string) => data.pending.filter(draft => !isDecision(draft) && draft.threadId === id);
export const threadFileName = (id: string) => (/^[\w-]{1,160}$/.test(id) ? id : `id-${createHash('sha256').update(id).digest('hex')}`) + '.json';
const plain = (text: string) => text.replace(/[\\`*_[\]<>#]/g, '\\$&');
const quote = (text: string) => text.split('\n').map(line => '> ' + plain(line)).join('\n');
const withoutGeneration = ({ generation: _, ...record }: ThreadFile) => record;
const readonlyPart = ({ localEdits: _, ...record }: ThreadFile) => record;
const incoming = (file: ThreadFile) => {
  const content = ({ thread, anchor }: ThreadFile['baseline']) => ({ thread, anchor: anchor && { path: anchor.path, documentId: anchor.documentId, quotedText: anchor.quotedText, state: anchor.state } });
  return !same(content(file.baseline), content(file.remote));
};
function anchorOf(inspection: Inspection | undefined, id: string): SourceAnchor | null {
  for (const doc of inspection?.docs ?? []) {
    const anchor = doc.comments.find(item => item.threadId === id);
    if (anchor) return { path: doc.path, documentId: doc.docId, line: anchor.ranges.length && !['anchor removed', 'position unknown'].includes(anchor.state) ? doc.text.slice(0, anchor.ranges[0].pos).split('\n').length : null,
      quotedText: anchor.ranges.map(range => doc.text.slice(range.pos, range.pos + range.length)).join(' … '), ranges: anchor.ranges, state: anchor.state };
  }
  return null;
}
/** A thread file as written to review/threads/, before its generation is set. */
export function recordFor(store: Pick<ProjectStore, 'key'>, data: ProjectData, id: string): ThreadFile {
  const pending = draftsFor(data, id), parent = pending.find(draft => draft.kind === 'createThread'), selection = parent?.anchor;
  return { $schema: '../thread.schema.json', schema: 1, projectKey: store.key, threadId: id, generation: '',
    baseline: { thread: data.acknowledged?.threads[id] ?? null, anchor: anchorOf(data.acknowledged, id) },
    remote: { thread: (data.observed ?? data.acknowledged)?.threads[id] ?? null, anchor: anchorOf(data.observed ?? data.acknowledged, id) },
    localSelection: parent && selection ? { path: parent.path, documentId: parent.docId, line: selection.source.slice(0, selection.from).split('\n').length,
      quotedText: selection.source.slice(selection.from, selection.to), ranges: [{ pos: selection.from, length: selection.to - selection.from }], state: 'local draft' } : null,
    uncertainEditIds: pending.filter(draft => draft.uncertain).map(draft => draft.id), localEdits: pending.map(editOf) };
}
async function readOptional(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8'); } catch (error: any) { if (error.code === 'ENOENT') return; throw error; }
}
function parse(content: string, name: string): ThreadFile {
  try {
    const value = JSON.parse(content);
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.localEdits)) throw new Error();
    return value;
  } catch { throw new SyncError(`${name}: restore valid JSON with a localEdits array. Your file has been preserved.`, 'review-files'); }
}
function validateEdit(value: unknown, name: string): asserts value is LocalCommentEdit {
  const e = value as LocalCommentEdit;
  const actions = ['reply', 'editMessage', 'deleteMessage', 'deleteThread', 'resolve', 'reopen', 'createThread'];
  if (!e || typeof e !== 'object' || Array.isArray(e) || Object.keys(e).some(key => !['id', 'action', 'messageId', 'text'].includes(key)) || typeof e.id !== 'string' || !/^[\w-]{1,128}$/.test(e.id) || !actions.includes(e.action))
    throw new SyncError(`${name}: each local edit needs a unique id (letters, numbers, - or _) and a supported action.`, 'review-files');
  const needsText = ['reply', 'editMessage', 'createThread'].includes(e.action), needsMessage = ['editMessage', 'deleteMessage'].includes(e.action);
  if (needsText ? typeof e.text !== 'string' || !e.text.trim() || e.text.length > 20_000 : e.text !== undefined)
    throw new SyncError(`${name}: ${e.action} ${needsText ? 'needs text between 1 and 20,000 characters' : 'does not accept text'}.`, 'review-files');
  if (needsMessage ? typeof e.messageId !== 'string' || !e.messageId : e.messageId !== undefined)
    throw new SyncError(`${name}: ${e.action} ${needsMessage ? 'needs the original messageId' : 'does not accept messageId'}.`, 'review-files');
}

/** A new anchored comment requested by a file in `review/new/`, located by its quoted source text. */
export interface NewCommentRequest { id: string; path: string; quote: string; occurrence?: number; line?: number; text: string }
const requestKeys = ['$schema', 'id', 'path', 'quote', 'occurrence', 'line', 'text'];
const lineAt = (text: string, pos: number) => text.slice(0, pos).split('\n').length;
function parseRequest(content: string, name: string): NewCommentRequest {
  const fail = (detail: string) => new SyncError(`${name}: ${detail} Your file has been preserved.`, 'review-files');
  let value: any;
  try { value = JSON.parse(content); } catch { throw fail('restore valid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !requestKeys.includes(key))) throw fail(`use only the fields ${requestKeys.slice(1).join(', ')}.`);
  if (typeof value.id !== 'string' || !/^[\w-]{1,128}$/.test(value.id)) throw fail('id needs 1 to 128 letters, numbers, - or _.');
  if (typeof value.path !== 'string' || !value.path) throw fail('path needs the project-relative source file.');
  if (typeof value.quote !== 'string' || !value.quote.trim()) throw fail('quote needs the exact saved source text to comment on.');
  if (typeof value.text !== 'string' || !value.text.trim() || value.text.length > 20_000) throw fail('text needs between 1 and 20,000 characters.');
  for (const key of ['occurrence', 'line']) if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || value[key] < 1)) throw fail(`${key} must be a whole number from 1.`);
  if (value.occurrence !== undefined && value.line !== undefined) throw fail('give occurrence or line, not both.');
  return value;
}
/** The UTF-16 range of the requested quote in the saved source; ambiguous or missing quotes are refused. */
export function locateQuote(source: string, request: NewCommentRequest, name: string): { from: number; to: number } {
  const fail = (detail: string) => new SyncError(`${name}: ${detail} Your file has been preserved.`, 'review-files');
  const starts: number[] = [];
  for (let at = source.indexOf(request.quote); at >= 0; at = source.indexOf(request.quote, at + 1)) starts.push(at);
  if (!starts.length) throw fail(`quote was not found in the saved ${request.path}. Copy it exactly from the saved file, including line breaks.`);
  const lines = starts.map(at => lineAt(source, at)), listed = [...new Set(lines)].join(', ');
  let picked = starts;
  if (request.line !== undefined) {
    picked = starts.filter((_, index) => lines[index] === request.line);
    if (!picked.length) throw fail(`quote does not start on line ${request.line} of ${request.path}; it starts on line ${listed}.`);
    if (picked.length > 1) throw fail(`quote starts ${picked.length} times on line ${request.line}. Quote a longer passage.`);
  } else if (request.occurrence !== undefined) {
    if (request.occurrence > starts.length) throw fail(`quote occurs ${starts.length} time(s) in ${request.path}; occurrence ${request.occurrence} does not exist.`);
    picked = [starts[request.occurrence - 1]];
  } else if (starts.length > 1) throw fail(`quote occurs ${starts.length} times in ${request.path} (lines ${listed}). Add "line" or "occurrence", or quote a longer passage.`);
  return { from: picked[0], to: picked[0] + request.quote.length };
}

/** Editable review records are an opt-in projection of the existing draft queue. */
export class LocalReviewFiles {
  constructor(readonly store: ProjectStore) {}
  async path(file = 'REVIEW.md'): Promise<string> { return this.store.path(`review/${file}`); }
  async enable(): Promise<boolean> {
    await this.store.update(data => { data.reviewFiles ??= { schema: 1, records: {} }; });
    return this.sync();
  }
  /** Imports what was saved there, then removes the folder. Queued drafts stay; a refused file keeps everything in place. */
  async disable(): Promise<void> {
    await this.store.exclusive(async () => {
      await this.importEdits();
      await this.store.update(data => { delete data.reviewFiles; });
      await rm(dirname(await this.path()), { recursive: true, force: true });
    });
  }
  /** Import all saved records atomically. No remote reads or writes occur here. */
  async importEdits(): Promise<boolean> {
    return this.store.exclusive(async () => {
      const data = await this.store.read();
      if (!data.reviewFiles) return false;
      let pending = [...data.pending], changed = false;
      const records = structuredClone(data.reviewFiles.records);
      for (const [id, exported] of Object.entries(records)) {
        const name = `threads/${threadFileName(id)}`, content = await readOptional(await this.path(name));
        // Removing a file is not a request to remove a remote discussion.
        if (content === undefined) continue;
        const input = parse(content, name), before = parse(exported.content, name);
        if (!same(readonlyPart(input), readonlyPart(before))) {
          // An export may have reached disk immediately before an editor crash.
          // Adopt it only when it exactly represents today's state and drafts.
          const desired = recordFor(this.store, data, id);
          if (same(withoutGeneration(input), withoutGeneration(desired))) {
            records[id] = { content: json(input), drafts: draftsFor(data, id) }; continue;
          }
          throw new SyncError(`${name}: only localEdits is editable. This may be an older copy; undo the file edit and reopen Local review files before editing again.`, 'review-files');
        }
        if (same(input.localEdits, before.localEdits)) continue;
        if (data.localApply || data.partialSend || exported.drafts.some(draft => draft.uncertain))
          throw new SyncError(`${name}: reconcile the interrupted sync in Sync history before editing these drafts.`, 'recovery');
        // A new comment that followed its text after a save is not a conflicting edit.
        const current = draftsFor(data, id), unanchored = (drafts: CommentDraft[]) => drafts.map(({ anchor: _, ...draft }) => draft);
        if (!same(unanchored(current), unanchored(exported.drafts)))
          throw new SyncError(`${name}: these drafts changed in the editor or were already sent. Preserve your text, undo this file edit, and reopen Local review files.`, 'review-files');
        const ids = new Set<string>();
        const replacements = input.localEdits.map(edit => {
          validateEdit(edit, name);
          if (ids.has(edit.id) || pending.some(draft => draft.id === edit.id && draft.threadId !== id)) throw new SyncError(`${name}: edit id ${edit.id} is already used. Give each edit a distinct id.`, 'review-files');
          ids.add(edit.id);
          const prior = current.find(draft => draft.id === edit.id);
          if (prior && (prior.kind !== edit.action || prior.messageId !== edit.messageId)) throw new SyncError(`${name}: keep an existing edit's id, action and messageId together. Use a new id for a different action.`, 'review-files');
          if (prior && same(editOf(prior), edit)) return prior;
          if (edit.action === 'createThread' && !prior) throw new SyncError(`${name}: create new threads with a file in new/ (see REVIEW.md) or New Comment on Selection, which establish their source anchor. Their text can then be edited here.`, 'review-files');
          const source = before.localSelection ?? before.baseline.anchor, thread = before.baseline.thread;
          if (!source || !this.store.paths.includes(source.path) || (!thread && !before.localSelection)) throw new SyncError(`${name}: Apply incoming comments before editing this thread.`, 'incoming');
          if (['editMessage', 'deleteMessage'].includes(edit.action)) {
            const message = thread?.messages.find(message => message.id === edit.messageId);
            if (!message?.authorId || message.authorId !== data.acknowledged?.userId) throw new SyncError(`${name}: only your own remote messages can be edited or deleted.`, 'read-only');
          }
          return { ...prior, id: edit.id, kind: edit.action, path: source.path, docId: source.documentId, threadId: id,
            ...edit.messageId && { messageId: edit.messageId }, ...edit.text !== undefined && { text: edit.text },
            // An explicit revision against a freshly exported/accepted thread
            // reconciles a stale draft, just as Edit draft in the panel does.
            // Unchanged entries above retain their original concurrency fence.
            before: thread ? structuredClone(thread) : undefined, created: prior?.created ?? new Date().toISOString() } satisfies CommentDraft;
        });
        if (replacements.some(draft => draft.kind === 'deleteThread') && replacements.length !== 1) throw new SyncError(`${name}: deleteThread must be the only edit for its thread.`, 'review-files');
        if (!before.baseline.thread && replacements.length && !replacements.some(draft => draft.kind === 'createThread')) throw new SyncError(`${name}: keep the new comment together with its replies, or remove all its edits.`, 'review-files');
        // Preserve the global send order of existing edits; append new edits.
        pending = pending.flatMap(draft => draft.threadId !== id || isDecision(draft) ? [draft] : replacements.filter(item => item.id === draft.id));
        pending.push(...replacements.filter(item => !exported.drafts.some(old => old.id === item.id)));
        records[id] = { content: json(input), drafts: replacements }; changed = true;
      }
      const requests = await this.requestFiles();
      if (requests.length && (data.localApply || data.partialSend)) throw new SyncError(`${requests[0].name}: reconcile the interrupted sync in Sync history before adding comments.`, 'recovery');
      const saved = new Map<string, string>(), seen = new Set<string>();
      for (const file of requests) {
        const request = parseRequest(file.content, file.name);
        if (seen.has(request.id)) throw new SyncError(`${file.name}: id ${request.id} is used by another file in new/. Give each new comment a distinct id.`, 'review-files');
        seen.add(request.id);
        if (!this.store.paths.includes(request.path)) throw new SyncError(`${file.name}: ${request.path} is not a selected source file.`, 'review-files');
        const doc = data.acknowledged?.docs.find(doc => doc.path === request.path);
        if (!doc) throw new SyncError(`${file.name}: ${request.path} is not on Overleaf in the last accepted state. Send it or Get latest first.`, 'incoming');
        if (!saved.has(request.path)) saved.set(request.path, (await readSaved(this.store.root, [request.path]))[request.path]!);
        const source = saved.get(request.path)!, anchor = { ...locateQuote(source, request, file.name), source };
        // Reusing the id of a queued new comment moves it, e.g. after its file was edited.
        const prior = pending.find(draft => draft.id === request.id);
        if (prior && (prior.kind !== 'createThread' || prior.path !== request.path)) throw new SyncError(`${file.name}: id ${request.id} is already used. Use a new id; reuse an id only to move a new comment queued in the same file.`, 'review-files');
        if (prior?.uncertain) throw new SyncError(`${file.name}: inspect the uncertain result in Sync history before changing this draft.`, 'recovery');
        const draft: CommentDraft = prior ? { ...prior, text: request.text, anchor }
          : { id: request.id, kind: 'createThread', path: request.path, docId: doc.docId, threadId: randomUUID().replaceAll('-', '').slice(0, 24), text: request.text, anchor, created: new Date().toISOString() };
        if (prior && same(prior, draft)) continue;
        pending = prior ? pending.map(item => item.id === draft.id ? draft : item) : [...pending, draft]; changed = true;
      }
      if (changed || !same(records, data.reviewFiles.records)) await this.store.update(current => { current.pending = pending; current.reviewFiles = { schema: 1, records }; });
      // A request rewritten during the import stays for the next one.
      for (const file of requests) if (await readOptional(file.path) === file.content) await unlink(file.path);
      return changed;
    });
  }
  /** Request files in `review/new/`; nothing there is written by the extension except removal after import. */
  private async requestFiles(): Promise<{ name: string; path: string; content: string }[]> {
    const folder = await this.path('new');
    let names: string[];
    try { names = await readdir(folder); } catch (error: any) { if (error.code === 'ENOENT') return []; throw error; }
    const files = [];
    for (const file of names.filter(name => name.endsWith('.json') && !name.startsWith('.')).sort()) {
      const name = `new/${file}`, path = join(folder, file), info = await lstat(path);
      if (!info.isFile()) throw new SyncError(`${name}: use a regular JSON file, not a link or folder.`, 'review-files');
      if (info.size > 100_000) throw new SyncError(`${name}: keep a new-comment file under 100 KB.`, 'review-files');
      files.push({ name, path, content: await readFile(path, 'utf8') });
    }
    return files;
  }
  /** Imports edits and requests, then refreshes the generated files. A refusal is also written to `import-error.txt`. */
  async sync(): Promise<boolean> {
    return this.store.exclusive(async () => {
      try {
        const changed = await this.export();
        await unlink(await this.path('import-error.txt')).catch((error: any) => { if (error.code !== 'ENOENT') throw error; });
        return changed;
      } catch (error: any) {
        if ((await this.store.read().catch(() => undefined))?.reviewFiles)
          await this.writeGenerated('import-error.txt', `${new Date().toISOString()}\n${error?.message ?? String(error)}\n`).catch(() => undefined);
        throw error;
      }
    });
  }
  private async export(): Promise<boolean> {
    const changed = await this.importEdits(), data = await this.store.read();
    if (!data.reviewFiles) return false;
    const records = structuredClone(data.reviewFiles.records);
    const ids = [...new Set([...Object.keys(records), ...Object.keys(data.acknowledged?.threads ?? {}), ...Object.keys(data.observed?.threads ?? {}), ...data.pending.filter(draft => !isDecision(draft)).map(draft => draft.threadId)])].sort();
    const files: ThreadFile[] = [];
    for (const id of ids) {
      const name = `threads/${threadFileName(id)}`, path = await this.path(name), desired = recordFor(this.store, data, id), prior = records[id] && parse(records[id].content, name);
      desired.generation = prior && same(withoutGeneration(prior), withoutGeneration(desired)) ? prior.generation : randomUUID();
      const disk = await readOptional(path);
      if (disk !== undefined) {
        const input = parse(disk, name);
        if (!same(input, prior) && !same(withoutGeneration(input), withoutGeneration(desired))) throw new SyncError(`${name}: the file changed during export. Save it and reopen Local review files; your text was preserved.`, 'review-files');
      }
      if (disk === undefined || !same(parse(disk, name), desired)) await atomicJson(path, desired);
      records[id] = { content: json(desired), drafts: draftsFor(data, id) }; files.push(desired);
    }
    if (!same(records, data.reviewFiles.records)) await this.store.update(current => { current.reviewFiles = { schema: 1, records }; });
    await this.writeGenerated('thread.schema.json', json(threadSchema));
    await this.writeGenerated('new-comment.schema.json', json(requestSchema));
    await mkdir(await this.path('new'), { recursive: true });
    await this.writeGenerated('index.json', json(this.index(data, files)));
    await this.writeGenerated('REVIEW.md', this.markdown(data, files));
    return changed;
  }
  private async writeGenerated(name: string, text: string): Promise<void> {
    const path = await this.path(name);
    if (await readOptional(path) === text) return;
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, text, { mode: 0o600 }); await rename(temp, path);
  }
  private index(data: ProjectData, files: ThreadFile[]) {
    const entries = files.map(file => {
      const source = file.localSelection ?? file.baseline.anchor ?? file.remote.anchor;
      return { threadId: file.threadId, file: `threads/${threadFileName(file.threadId)}`, sourceFile: source?.path ?? null,
        baselineLine: file.baseline.anchor?.line ?? null, remoteLine: file.remote.anchor?.line ?? null, anchorState: source?.state ?? 'unplaced',
        resolved: file.remote.thread?.resolved ?? null, incoming: incoming(file), pendingEdits: file.localEdits.length };
    });
    return { schema: 1, project: { key: this.store.key, id: this.store.projectId, name: (data.observed ?? data.acknowledged)?.projectName, server: this.store.baseUrl, selectedFiles: this.store.paths },
      baselineRevision: data.revision ?? null, remoteFetchedAt: (data.observed ?? data.acknowledged)?.fetchedAt ?? null,
      newComments: { folder: 'new/', schema: 'new-comment.schema.json' },
      threads: entries, bySourceFile: Object.fromEntries([...new Set(entries.map(entry => entry.sourceFile).filter((path): path is string => !!path))].sort().map(path => [path, entries.filter(entry => entry.sourceFile === path).map(entry => entry.threadId)])) };
  }
  private markdown(data: ProjectData, files: ThreadFile[]): string {
    const lines = ['# Overleaf local review', '', `Project: ${plain((data.observed ?? data.acknowledged)?.projectName ?? this.store.projectId)}`, '',
      '[Thread index](index.json) · [JSON schema](thread.schema.json) · [New comment schema](new-comment.schema.json)', '',
      'This overview and the index are generated. Edit only `localEdits` in the linked thread JSON files. Saving queues local drafts; **Send** in the sidebar summary publishes them.', '',
      'Keep the other fields unchanged: `baseline` is the last accepted discussion; `remote` is the latest fetched discussion. Anchors include the source document ID, quoted text and UTF-16 ranges. Line numbers refer to those snapshots.', '',
      'For a reply, add `{ "id": "my-reply-1", "action": "reply", "text": "Your reply" }` to `localEdits`. Each edit needs a distinct ID across this project. To revise your message, use `editMessage` with its `messageId` and `text`. `resolve`, `reopen`, `deleteMessage` (with `messageId`) and `deleteThread` are also supported. Delete actions still require confirmation at Send.', '',
      'Edit a queued entry’s text to revise it; remove it from `localEdits` to discard that draft. Deleting a JSON file does not delete a discussion; the file is regenerated. Suggestion decisions remain in the extension.', '',
      'To start a new comment thread, save a JSON file in `new/` ([schema](new-comment.schema.json)), for example `{ "id": "my-comment-1", "path": "main.tex", "quote": "exact saved source text", "text": "Your comment" }`. `quote` must match the saved file exactly; if it occurs more than once, add `"line"` (where it starts) or `"occurrence"` (1-based). The file is removed once queued, and the new thread appears below with a `createThread` entry. **New Comment on Selection** in the editor does the same. A new comment follows its text when the file is saved with other edits; if the commented text itself changes, save a request with the same `id` again to move the comment.', '',
      'Invalid or stale files are preserved and block Send until corrected; the reason is written to `import-error.txt`. If drafts changed in the panel while you edited a file, preserve your new text, undo the JSON edit, reopen **Local review files**, and apply the text to the updated record. Unsaved JSON buffers are never overwritten by a background export.', '',
      `Remote snapshot fetched: ${(data.observed ?? data.acknowledged)?.fetchedAt ?? 'not fetched'}. Open **Get latest** to review incoming changes. Source file differences remain available in the extension’s native diff editors; edit the actual source files or the proposed merged copy.`, ''];
    for (const file of files) {
      const source = file.localSelection ?? file.baseline.anchor ?? file.remote.anchor;
      lines.push(`## ${plain(source?.path ?? 'Unplaced thread')}:${source?.line ?? '?'} · ${plain(file.threadId)}`, '',
        `[Edit thread JSON](threads/${threadFileName(file.threadId)}) · ${file.remote.thread?.resolved ? 'Resolved' : file.remote.thread ? 'Open' : 'Not present remotely'} · ${plain(anchorLabel(source?.state ?? 'unplaced'))} · ${file.localEdits.length} pending edit(s)${incoming(file) ? ' · Incoming changes' : ''}`, '');
      if (source?.quotedText) lines.push(quote(source.quotedText), '');
      if (incoming(file)) lines.push('Last accepted discussion:', '', ...threadMarkdown(file.baseline.thread));
      lines.push('Latest remote discussion:', '', ...threadMarkdown(file.remote.thread));
      if (file.localEdits.length) lines.push('Local edits waiting to send:', '', ...file.localEdits.flatMap(edit => [`- **${edit.action}** · ${plain(edit.id)}${edit.messageId ? ' · message ' + plain(edit.messageId) : ''}${file.uncertainEditIds.includes(edit.id) ? ' · uncertain result; reconcile first' : ''}`, ...edit.text ? [quote(edit.text)] : [], '']));
    }
    if (!files.length) lines.push('No comment threads have been fetched yet.', '');
    return lines.join('\n');
  }
}
function threadMarkdown(thread: Thread | null): string[] {
  return thread ? [`${thread.resolved ? 'Resolved' : 'Open'}`, '', ...thread.messages.flatMap(message => [`**${plain(message.author)}**${message.id ? ' · ' + plain(message.id) : ''}`, '', quote(message.text), ''])] : ['No thread in this snapshot.', ''];
}
const threadSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#', title: 'Overleaf comment thread', type: 'object', additionalProperties: false,
  required: ['$schema', 'schema', 'projectKey', 'threadId', 'generation', 'baseline', 'remote', 'localSelection', 'uncertainEditIds', 'localEdits'],
  properties: {
    $schema: { type: 'string', readOnly: true }, schema: { const: 1, readOnly: true },
    ...Object.fromEntries(['projectKey', 'threadId', 'generation'].map(key => [key, { type: 'string', readOnly: true }])),
    baseline: { type: 'object', readOnly: true }, remote: { type: 'object', readOnly: true }, localSelection: { type: ['object', 'null'], readOnly: true }, uncertainEditIds: { type: 'array', items: { type: 'string' }, readOnly: true },
    localEdits: { type: 'array', description: 'Edit these drafts locally. Nothing is published until Send.', items: {
      type: 'object', additionalProperties: false, required: ['id', 'action'], properties: {
        id: { type: 'string', pattern: '^[\\w-]{1,128}$', description: 'Stable edit ID, unique across this project; retain it when revising a draft.' },
        action: { enum: ['reply', 'editMessage', 'deleteMessage', 'resolve', 'reopen', 'deleteThread', 'createThread'] },
        messageId: { type: 'string', minLength: 1 }, text: { type: 'string', minLength: 1, maxLength: 20000 },
      }, allOf: [
        { if: { properties: { action: { enum: ['reply', 'editMessage', 'createThread'] } } }, then: { required: ['text'] }, else: { not: { required: ['text'] } } },
        { if: { properties: { action: { enum: ['editMessage', 'deleteMessage'] } } }, then: { required: ['messageId'] }, else: { not: { required: ['messageId'] } } },
      ],
    } },
  },
};
const requestSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#', title: 'New Overleaf comment', type: 'object', additionalProperties: false,
  description: 'Queues a new comment thread on the quoted saved source text. Nothing is published until Send.',
  required: ['id', 'path', 'quote', 'text'], not: { required: ['occurrence', 'line'] },
  properties: {
    $schema: { type: 'string' },
    id: { type: 'string', pattern: '^[\\w-]{1,128}$', description: 'Draft ID, unique across this project. Reuse it to move a queued new comment.' },
    path: { type: 'string', minLength: 1, description: 'Project-relative selected source file, for example main.tex.' },
    quote: { type: 'string', minLength: 1, description: 'Exact text of the saved file to comment on, including line breaks.' },
    occurrence: { type: 'integer', minimum: 1, description: 'Which match of quote to use (1-based) when it occurs more than once.' },
    line: { type: 'integer', minimum: 1, description: 'Line where quote starts (1-based) when it occurs more than once.' },
    text: { type: 'string', minLength: 1, maxLength: 20000, description: 'The comment.' },
  },
};
