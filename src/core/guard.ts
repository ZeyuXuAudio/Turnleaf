import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { SyncError, safeError } from './errors';
import { assertRepositoryLocks } from './lock';
import type { SuggestionRef } from './suggestions';

const permits = new WeakSet<object>();
// 'edit' sends reviewed text as a versioned realtime operation against `version`;
// 'acceptChange' and 'rejectChange' decide the suggestion `change` at `version`.
// 'createFolder' and 'createDoc' make an empty folder or text document `path` in the folder `folderId`;
// 'deleteDoc' removes the document `docId` (Undo this send of a created file). Folders are never deleted.
// 'uploadFile' uploads the picture `bytes` as `path` into the folder `folderId`, which must hash to `hash`;
// 'deleteFile' removes the non-text file `fileId` (Undo this send of a created picture).
// `untracked`: an edit that never becomes suggestions (the content of a created file).
export interface WriteAction { kind: 'upload' | 'uploadFile' | 'deleteFile' | 'edit' | 'createFolder' | 'createDoc' | 'deleteDoc' | 'reply' | 'resolve' | 'reopen' | 'editMessage' | 'deleteMessage' | 'deleteThread' | 'createThread' | 'acceptChange' | 'rejectChange'; projectId: string; docId?: string; threadId?: string; messageId?: string; folderId?: string; fileId?: string; hash?: string; path?: string; bytes?: Buffer; version?: number; text?: string; anchor?: { from: number; to: number; source: string }; change?: SuggestionRef; untracked?: boolean; }
export interface WriteState { init(): Promise<void>; path(file: string): Promise<string>; exclusive<T>(action: () => Promise<T>): Promise<T>; }
export interface WritePermit { readonly action: WriteAction; }
export function requirePermit(permit: WritePermit): WriteAction {
  if (!permits.has(permit)) throw new SyncError('A confirmed write permit is required.', 'read-only');
  permits.delete(permit); // one use; an HTTP failure cannot silently resend a write
  return permit.action;
}
export function validateUpload(path: string, bytes: Buffer): string {
  if (bytes.length > 1024 * 1024) throw new SyncError(`${path}: exceeds the 1 MB upload limit.`, 'import');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch {
    // Locate the first malformed sequence only on the error path.
    let offset = 0;
    for (; offset < bytes.length;) {
      const lead = bytes[offset], n = lead < 0x80 ? 1 : lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0;
      if (!n || offset + n > bytes.length) break;
      const second = bytes[offset + 1];
      if (n > 1 && (second < 0x80 || second > 0xbf || lead === 0xe0 && second < 0xa0 || lead === 0xed && second > 0x9f || lead === 0xf0 && second < 0x90 || lead === 0xf4 && second > 0x8f)) break;
      if (Array.from(bytes.subarray(offset + 2, offset + n)).some(b => b < 0x80 || b > 0xbf)) break;
      offset += n;
    }
    const prefix = bytes.subarray(0, offset).toString('utf8');
    throw new SyncError(`${path}:${prefix.split('\n').length}:${prefix.length - prefix.lastIndexOf('\n')}: invalid UTF-8. Save as UTF-8 before uploading.`, 'import');
  }
  const match = /[\x00\r\uD800-\uDFFF]/.exec(text);
  if (match) {
    const prefix = text.slice(0, match.index), line = prefix.split('\n').length, column = match.index - prefix.lastIndexOf('\n');
    const reason = match[0] === '\0' ? 'NUL character' : match[0] === '\r' ? 'CR line ending; use LF' : 'character outside the Basic Multilingual Plane';
    throw new SyncError(`${path}:${line}:${column}: ${reason}. Upload refused to protect the document and its comments.`, 'import');
  }
  return text;
}
export async function guardedWrite<T>(state: WriteState, action: WriteAction, allow: () => boolean, confirm: () => Promise<boolean>, perform: (permit: WritePermit) => Promise<T>, output: (line: string) => void): Promise<T> {
  if (!allow()) throw new SyncError('Enable sending in the Overleaf project view before writing to Overleaf.', 'read-only');
  if (action.kind === 'upload' || action.kind === 'edit') validateUpload(action.path!, action.bytes!);
  if (!await confirm()) throw new SyncError('Write cancelled.', 'cancelled');
  return state.exclusive(async () => {
    if (!allow()) throw new SyncError('Writes were disabled while confirmation was open.', 'read-only');
    await state.init();
    const log = await state.path('writes.jsonl');
    await mkdir(dirname(log), { recursive: true });
    const entry = { time: new Date().toISOString(), action: action.kind, project: action.projectId, file: action.path, thread: action.threadId, bytes: action.bytes?.length ?? Buffer.byteLength(action.text ?? '') };
    // `time` is when the write started; later lines also carry when it finished.
    const record = async (result: string) => { const line = JSON.stringify({ ...entry, ...result !== 'started' && { finished: new Date().toISOString() }, result }); await appendFile(log, line + '\n', { mode: 0o600 }); output(line); };
    // If the audit path is unwritable, stop before sending anything.
    await record('started');
    const permit = Object.freeze({ action: { ...action, bytes: action.bytes && Buffer.from(action.bytes) } });
    permits.add(permit);
    try { assertRepositoryLocks(); const result = await perform(permit); await record('ok'); return result; }
    catch (error) { await record(`failed or outcome unknown: ${safeError(error)}`); throw error; }
    finally { permits.delete(permit); }
  });
}
