import { constants } from 'node:fs';
import { open, writeFile, rename, rm, mkdir, lstat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { workspacePath } from './storage';
import { SyncError } from './errors';
import { checkCancelled } from './operation';
import { diffText } from './diff';

export type SavedTexts = Record<string, string | null>;

export async function readSaved(root: string, paths: string[], missing = false): Promise<SavedTexts> {
  const result: SavedTexts = {};
  for (const path of paths) {
    const full = await workspacePath(root, path);
    let file;
    try {
      file = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new SyncError(`${path}: choose a regular text file under 1 MB.`, 'import');
      const bytes = await file.readFile();
      try { result[path] = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { throw new SyncError(`${path}: save as UTF-8 before reviewing.`, 'import'); }
      if (result[path]!.includes('\0')) throw new SyncError(`${path}: binary files cannot be synchronized.`, 'import');
    } catch (error: any) {
      if (error.code === 'ENOENT' && missing) result[path] = null;
      else throw error;
    } finally { await file?.close(); }
  }
  return result;
}

export function sameSaved(a: SavedTexts, b: SavedTexts): boolean {
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(path => a[path] === b[path]);
}

// Only replace a file while it still contains the reviewed input. A checkpoint
// and apply journal are persisted by the caller before entering this function.
export async function replaceSaved(root: string, path: string, before: string | null, after: string | null, valid: () => boolean): Promise<void> {
  const full = await workspacePath(root, path);
  if (!valid() || (await readSaved(root, [path], true))[path] !== before) throw new SyncError(`${path}: local contents changed. Review again.`, 'stale');
  if (after === null) {
    if (!valid()) throw new SyncError('Editor changed during apply.', 'stale');
    await rm(full, { force: true }); return;
  }
  await mkdir(dirname(full), { recursive: true });
  const mode = before === null ? 0o644 : (await lstat(full)).mode & 0o777;
  const temp = `${full}.overleaf-${randomUUID()}.tmp`;
  try {
    await writeFile(temp, after, { encoding: 'utf8', mode, flag: 'wx' });
    checkCancelled();
    await workspacePath(root, path);
    if (!valid() || (await readSaved(root, [path], true))[path] !== before) throw new SyncError(`${path}: local contents changed. Review again.`, 'stale');
    await rename(temp, full);
  } finally { await rm(temp, { force: true }); }
}

// `line`: where in the shared baseline the first overlapping edits start.
export async function mergeSaved(base: string, local: string, remote: string): Promise<{ text: string; conflict: boolean; line?: number }> {
  if (local === remote || remote === base) return { text: local, conflict: false };
  if (local === base) return { text: remote, conflict: false };
  type Edit = { from: number; to: number; text: string; side: 'local' | 'remote' };
  const edits = (text: string, side: Edit['side']): Edit[] => {
    const result: Edit[] = []; let offset = 0, pending: Edit | undefined;
    for (const [kind, value] of diffText(base, text).diffs) {
      if (kind === 0) {
        if (pending) result.push(pending);
        pending = undefined; offset += value.length;
      } else {
        pending ??= { from: offset, to: offset, text: '', side };
        if (kind === -1) { offset += value.length; pending.to = offset; }
        else pending.text += value;
      }
    }
    if (pending) result.push(pending);
    return result;
  };
  const combined = [...edits(local, 'local'), ...edits(remote, 'remote')].sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: Edit[] = [];
  for (const edit of combined) {
    const prior = merged.at(-1);
    if (prior && prior.side !== edit.side) {
      if (prior.from === edit.from && prior.to === edit.to && prior.text === edit.text) continue;
      // Different insertions at the same position, or an insertion on the edge
      // of a replacement, have ambiguous order. Keep both complete versions.
      const insertionBoundary = prior.to === edit.from && (prior.from === prior.to || edit.from === edit.to);
      if (edit.from < prior.to || insertionBoundary) {
        return { text: mergeConflict(local, base, remote), conflict: true, line: base.slice(0, prior.from).split('\n').length };
      }
    }
    merged.push(edit);
  }
  let offset = 0, text = '';
  for (const edit of merged) { text += base.slice(offset, edit.from) + edit.text; offset = edit.to; }
  return { text: text + base.slice(offset), conflict: false };
}

export function mergeConflict(local: string, base: string | undefined, remote: string): string {
  const line = (text: string) => text && !text.endsWith('\n') ? text + '\n' : text;
  return `<<<<<<< Saved local\n${line(local)}${base === undefined ? '' : `||||||| Shared baseline\n${line(base)}`}=======\n${line(remote)}>>>>>>> Overleaf\n`;
}
