// Pictures and PDF figures (PNG, JPG, PDF), compared and sent by content hash.
// Every .png .jpg .jpeg .pdf on Overleaf is tracked while `turnleaf.syncPictures` is on.
// Files are compared by the Git blob SHA-1 that Overleaf's tree gives as `hash`; the
// baseline keeps only that hash, per project and outside the text file selection.
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Inspection, RemoteFile } from './models';
import { workspacePath } from './storage';
import { SyncError } from './errors';
import { checkCancelled } from './operation';

export const pictureExtensions = ['.png', '.jpg', '.jpeg', '.pdf'];
export const isPicture = (path: string): boolean => pictureExtensions.some(extension => path.toLowerCase().endsWith(extension));
/**
 * A picture path safe to use as a local file name: '/'-separated, without backslashes,
 * control characters or empty, '.' and '..' parts, by the rule `validateTrackedFiles`
 * applies to text files. A backslash would be one name on macOS and Linux but two to the
 * symbolic-link check of `workspacePath`, which could then miss a linked parent folder.
 */
export const safePicturePath = (path: string): boolean => !/[\\\x00-\x1f\x7f]/.test(path) && path.split('/').every(part => !!part && part !== '.' && part !== '..');
function assertSafe(path: string): void {
  if (!safePicturePath(path)) throw new SyncError(`${JSON.stringify(path)} is not a supported picture path (backslash, control character or empty, '.' or '..' part).`, 'configuration');
}
/** Overleaf CE's `maxUploadSize`, used when the project page does not give one. */
export const defaultUploadLimit = 50 * 1024 * 1024;
export const gitBlobSha1 = (bytes: Buffer): string => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const sha1 = /^[0-9a-f]{40}$/;
export const validHash = (value: unknown): value is string => typeof value === 'string' && sha1.test(value);

/** 120 KB, 1.4 MB: sizes for rows, in decimal units as file managers show them. */
export function formatSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1000, unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1).replace(/\.0$/, '')} ${units[unit]}`;
}

/** The tracked pictures of an Overleaf state: every allowlisted non-text file of its tree. */
export function remotePictures(inspection: Inspection | undefined): Record<string, RemoteFile> {
  const result: Record<string, RemoteFile> = {};
  // A name that is not a safe local path is not tracked: it is never read or written here.
  for (const [path, file] of Object.entries(inspection?.tree?.fileRefs ?? {})) if (isPicture(path) && safePicturePath(path)) result[path] = file;
  return result;
}
/** Same pictures on Overleaf: equal hashes and link state. A re-upload of the same bytes gets a new file ID and is not a change. */
export function samePictures(a: Inspection | undefined, b: Inspection | undefined): boolean {
  const view = (i: Inspection | undefined) => Object.entries(remotePictures(i)).map(([path, file]) => [path, file.hash ?? null, file.linked]).sort(([x], [y]) => String(x).localeCompare(String(y)));
  return JSON.stringify(view(a)) === JSON.stringify(view(b));
}

/**
 * The picture state of one project: the Overleaf hash last applied, acknowledged or
 * sent per path (`size` in bytes when known), and `added`: local-only pictures the
 * user added in Choose files, which Send creates on Overleaf.
 */
export interface PictureState { schema: 1; baseline: Record<string, { hash: string; size?: number }>; added?: string[]; }
export const emptyPictures = (): PictureState => ({ schema: 1, baseline: {} });
/** Whether Overleaf's pictures differ from the baseline, so Get latest has something to show. */
export function picturesIncoming(observed: Inspection | undefined, state: PictureState): boolean {
  if (!observed?.tree?.fileRefs) return false;
  const remote = remotePictures(observed);
  return Object.entries(remote).some(([path, file]) => state.baseline[path]?.hash !== file.hash) || Object.keys(state.baseline).some(path => !remote[path]);
}

/** A local picture: its Git blob SHA-1 and size; `hash` is absent for a file over the upload limit, which is not read. */
export interface LocalPicture { hash?: string; size: number; }
// Hashes by absolute path, reused while size, modification time and inode are unchanged,
// so the standing plan does not reread large PDFs.
const hashes = new Map<string, { size: number; mtimeMs: number; ctimeMs: number; ino: number; hash: string }>();
/** Reads a local picture by streaming it; null when it does not exist. Symbolic links and folders are refused. */
export async function localPicture(root: string, path: string, limit = defaultUploadLimit): Promise<LocalPicture | null> {
  assertSafe(path);
  const full = await workspacePath(root, path);
  let file;
  try { file = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error: any) {
    if (error.code === 'ENOENT') return null;
    if (error.code === 'ELOOP') throw new SyncError(`${path}: refusing a symbolic link.`, 'configuration');
    throw error;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new SyncError(`${path} is not a regular file in the local folder.`, 'import');
    if (stat.size > limit) return { size: stat.size };
    const known = hashes.get(full);
    if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs && known.ctimeMs === stat.ctimeMs && known.ino === stat.ino) return { hash: known.hash, size: stat.size };
    const hash = createHash('sha1').update(`blob ${stat.size}\0`);
    let read = 0;
    for await (const chunk of file.createReadStream({ autoClose: false }) as AsyncIterable<Buffer>) { read += chunk.length; hash.update(chunk); }
    if (read !== stat.size) throw new SyncError(`${path} changed while it was read. Review again.`, 'stale');
    const value = hash.digest('hex');
    hashes.set(full, { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino, hash: value });
    return { hash: value, size: stat.size };
  } finally { await file.close(); }
}
/** The bytes of a local picture, which must still hash to `hash`. */
export async function readPicture(root: string, path: string, hash: string): Promise<Buffer> {
  assertSafe(path);
  const file = await open(await workspacePath(root, path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = await file.readFile();
    if (gitBlobSha1(bytes) !== hash) throw new SyncError(`${path}: local contents changed. Review again.`, 'stale');
    return bytes;
  } finally { await file.close(); }
}

/**
 * Writes `bytes` to the local picture `path` only while it still has the reviewed
 * content `before` (a hash, or null for absent), as `replaceSaved` does for text.
 * `bytes` null removes the file.
 */
export async function replacePicture(root: string, path: string, before: string | null, bytes: Buffer | null, valid: () => boolean): Promise<void> {
  assertSafe(path);
  const full = await workspacePath(root, path);
  const unchanged = async () => valid() && ((await localPicture(root, path, Infinity))?.hash ?? null) === before;
  if (!await unchanged()) throw new SyncError(`${path}: local contents changed. Review again.`, 'stale');
  if (bytes === null) { await rm(full, { force: true }); return; }
  await mkdir(dirname(full), { recursive: true });
  const mode = before === null ? 0o644 : (await lstat(full)).mode & 0o777;
  const temp = `${full}.overleaf-${randomUUID()}.tmp`;
  try {
    await writeFile(temp, bytes, { mode, flag: 'wx' });
    checkCancelled();
    await workspacePath(root, path);
    if (!await unchanged()) throw new SyncError(`${path}: local contents changed. Review again.`, 'stale');
    await rename(temp, full);
  } finally { await rm(temp, { force: true }); }
}

/**
 * One tracked picture in the Get latest preview.
 * - new: only on Overleaf; Apply downloads it.
 * - changed: Overleaf changed it, the local copy is the baseline; Apply replaces it.
 * - restore: missing locally, unchanged on Overleaf; Apply puts Overleaf's copy back.
 * - both: changed on both sides, or different without a baseline; the user chooses (`choice`).
 * - deleted: gone on Overleaf; the local copy is kept and leaves tracking.
 * - linked-local: a linked file changed locally; nothing is written, `note` says why.
 * - blocked: cannot take part now; `note` says why.
 */
export type PictureKind = 'new' | 'changed' | 'restore' | 'both' | 'deleted' | 'linked-local' | 'blocked';
export interface IncomingPicture {
  path: string; kind: PictureKind;
  /** The local file when planned; null when absent. */
  local: LocalPicture | null;
  /** The Overleaf file; `size` once downloaded. */
  remote?: { id: string; hash: string; linked: boolean; size?: number };
  /** Baseline hash, when the picture was synchronized before. */
  base?: string;
  /** both: Use Overleaf version ('remote') or Keep my version ('local'). */
  choice?: 'remote' | 'local';
  /** Absolute path of the verified download, for Apply and the comparison. */
  download?: string;
  note?: string;
}
/** Whether Apply writes Overleaf's bytes to this picture. */
export const writesPicture = (picture: IncomingPicture): boolean => ['new', 'changed', 'restore'].includes(picture.kind) || picture.kind === 'both' && picture.choice === 'remote';
/** A row still waiting for the user's choice. */
export const pictureConflict = (picture: IncomingPicture): boolean => picture.kind === 'both' && !picture.choice;
/** Overleaf's copy is needed for Apply or for the comparison. */
export const needsDownload = (picture: IncomingPicture): boolean => !!picture.remote && ['new', 'changed', 'restore', 'both'].includes(picture.kind);

const linkedNote = 'Linked on Overleaf from another project or a URL; change it there. Your local change is not sent.';
/**
 * The picture rows of a Get latest preview, and the baseline Apply records. Reads
 * local files (hashes cached), never Overleaf: `fresh` is the Overleaf state read.
 * `local` keeps the local hash (or null) of every path considered, for the recheck at Apply.
 */
export async function planPictures(root: string, fresh: Inspection, state: PictureState, limit = fresh.maxUploadSize ?? defaultUploadLimit): Promise<{ pictures: IncomingPicture[]; local: Record<string, string | null>; next: PictureState }> {
  const remote = remotePictures(fresh), pictures: IncomingPicture[] = [], local: Record<string, string | null> = {};
  // A picture added in Choose files that is on Overleaf now is tracked like any other.
  const next: PictureState = { schema: 1, baseline: { ...state.baseline }, ...state.added && { added: state.added.filter(path => !remote[path]) } };
  const paths = [...new Set([...Object.keys(remote), ...Object.keys(state.baseline)])].sort();
  for (const path of paths) {
    const file = remote[path], base = state.baseline[path]?.hash;
    // Blocked rows and local changes waiting for Send keep their baseline; every other path takes Overleaf's.
    const block = (note: string, mine: LocalPicture | null = null) => { pictures.push({ path, kind: 'blocked', local: mine, base, note }); delete local[path]; };
    // The extension's own state folder is never written from Overleaf.
    if (path.split('/')[0] === '.turnleaf') { block('This folder name is reserved for Turnleaf. Rename the folder on Overleaf.'); continue; }
    let mine: LocalPicture | null;
    try { mine = await localPicture(root, path, limit); }
    catch (error) { if (!(error instanceof SyncError)) throw error; block(error.message); continue; }
    if (mine && mine.hash === undefined) { block(`${formatSize(mine.size)}, over Overleaf's ${formatSize(limit)} upload limit. It is not compared or replaced.`, mine); continue; }
    local[path] = mine?.hash ?? null;
    if (!file) {
      // Deleted on Overleaf (or no longer a picture there): the local copy stays and leaves tracking.
      delete next.baseline[path];
      if (mine) pictures.push({ path, kind: 'deleted', local: mine, base, note: 'Deleted on Overleaf. Your local copy is kept and no longer synchronized.' });
      continue;
    }
    if (!validHash(file.hash)) { block('Overleaf did not give this file\'s content hash, so it cannot be compared.', mine); continue; }
    const theirs = { id: file.id, hash: file.hash, linked: file.linked };
    if (file.hash === base && mine) {
      // A local change with Overleaf at the baseline goes out with Send (step nontext-files-send); a linked file says why it cannot.
      if (mine.hash !== base) { delete local[path]; if (file.linked) pictures.push({ path, kind: 'linked-local', local: mine, remote: theirs, base, note: linkedNote }); }
      continue;
    }
    next.baseline[path] = { hash: file.hash };
    if (mine?.hash === file.hash) { next.baseline[path].size = mine.size; continue; } // Equal bytes: acknowledged silently.
    if (!mine) pictures.push({ path, kind: file.hash === base ? 'restore' : base === undefined ? 'new' : 'changed', local: null, remote: theirs, base, ...base !== undefined && { note: file.hash === base ? 'Missing in the local folder. Apply restores Overleaf\'s copy.' : 'Missing in the local folder. Apply puts Overleaf\'s new version there.' } });
    else if (mine.hash === base) pictures.push({ path, kind: 'changed', local: mine, remote: theirs, base });
    else pictures.push({ path, kind: 'both', local: mine, remote: theirs, base, note: base === undefined ? 'Not synchronized before, and different from Overleaf\'s copy. Choose a version.' : 'Changed here and on Overleaf. Choose a version.' });
  }
  return { pictures, local, next };
}

/** The words of a preview row: `changed on Overleaf · 120 KB → 134 KB`. */
export function pictureSummary(picture: IncomingPicture): string {
  const before = picture.local?.size, after = picture.remote?.size;
  const sizes = before !== undefined && after !== undefined ? `${formatSize(before)} → ${formatSize(after)}` : after !== undefined ? formatSize(after) : before !== undefined ? formatSize(before) : '';
  const label: Record<PictureKind, string> = { new: 'new on Overleaf', changed: 'changed on Overleaf', restore: 'restored from Overleaf', both: 'changed on both sides', deleted: 'deleted on Overleaf, local copy kept', 'linked-local': 'linked on Overleaf', blocked: 'not synchronized' };
  return [label[picture.kind], sizes].filter(Boolean).join(' · ');
}

/** The content type an upload names for a picture. */
export function contentType(path: string): string {
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase();
  return extension === '.png' ? 'image/png' : extension === '.pdf' ? 'application/pdf' : 'image/jpeg';
}
/** The folders of `path`, parents first. */
export const parentFolders = (path: string): string[] => path.split('/').slice(0, -1).map((_, n, parts) => parts.slice(0, n + 1).join('/'));
const holds = (record: Record<string, string> | undefined, key: string) => !!record && Object.hasOwn(record, key);

/**
 * One picture of a Send, or of Undo this send (step nontext-files-send).
 * - replace: changed locally while Overleaf still has the baseline; Send uploads the local copy over it.
 * - create: only local and added in Choose files; Send uploads it, making missing folders first.
 * - restore: Undo this send uploads back the bytes the Send replaced, while Overleaf has what it wrote.
 * - delete: Undo this send deletes the file the Send created, while its ID and hash are unchanged.
 * - blocked: cannot go out now; `note` says why.
 */
export type OutgoingKind = 'replace' | 'create' | 'restore' | 'delete' | 'blocked';
export interface OutgoingPicture {
  path: string; kind: OutgoingKind;
  /** The bytes this step leaves on Overleaf (replace, create, restore), or the local copy of a blocked row. */
  hash?: string; size?: number;
  /** The Overleaf file the step expects right before it: its ID and hash (replace, restore, delete). */
  remote?: { id: string; hash: string; size?: number };
  /** create: the folders made first, parents first. */
  folders?: string[];
  note?: string;
}
/** Whether this row is written to Overleaf. */
export const sendsPicture = (picture: OutgoingPicture): boolean => picture.kind !== 'blocked';

/**
 * The picture rows of a Send: what goes out, and what cannot with the reason. Reads
 * local files (hashes cached), never Overleaf: `fresh` is the Overleaf state read.
 * A local change goes out only while Overleaf still has the baseline hash; a
 * local-only picture only once added in Choose files (`state.added`).
 */
export async function planOutgoing(root: string, fresh: Inspection, state: PictureState, limit = fresh.maxUploadSize ?? defaultUploadLimit): Promise<OutgoingPicture[]> {
  const tree = fresh.tree, rows: OutgoingPicture[] = [];
  if (!tree?.fileRefs) return rows;
  const remote = remotePictures(fresh), added = new Set(state.added ?? []);
  const over = (mine: LocalPicture) => `${formatSize(mine.size)}, over Overleaf's ${formatSize(limit)} upload limit. It is not sent.`;
  for (const path of [...new Set([...Object.keys(remote), ...Object.keys(state.baseline), ...added])].sort()) {
    if (path.split('/')[0] === '.turnleaf') continue;
    const file = remote[path], base = state.baseline[path];
    const block = (note: string, mine?: LocalPicture | null) => { rows.push({ path, kind: 'blocked', ...mine && { size: mine.size, ...mine.hash && { hash: mine.hash } }, note }); };
    let mine: LocalPicture | null;
    try { mine = await localPicture(root, path, limit); }
    catch (error) { if (!(error instanceof SyncError)) throw error; if (base || added.has(path)) block(error.message); continue; }
    if (file) {
      // Never synchronized: Get latest offers the choice. A picture added for Send says why it waits.
      if (!base) { if (added.has(path) && mine?.hash !== file.hash) block('Now on Overleaf too. Get latest to compare and choose a version.', mine); continue; }
      if (!mine || mine.hash === base.hash) continue;
      if (mine.hash === undefined) { block(over(mine), mine); continue; }
      if (file.hash !== base.hash) { if (mine.hash !== file.hash) block('Changed here and on Overleaf. Get latest to compare and choose a version.', mine); continue; }
      if (file.linked) { block(linkedNote, mine); continue; }
      rows.push({ path, kind: 'replace', hash: mine.hash, size: mine.size, remote: { id: file.id, hash: base.hash, ...base.size !== undefined && { size: base.size } } });
      continue;
    }
    // Deleted on Overleaf since the last sync: Get latest stops tracking it.
    if (base || !added.has(path)) continue;
    if (!mine) { block('Missing in the local folder. Remove it in Choose files.'); continue; }
    if (mine.hash === undefined) { block(over(mine), mine); continue; }
    if (holds(tree.docs, path)) { block('A text document of this name is on Overleaf. An upload would replace it and lose its comments. Rename one of them.', mine); continue; }
    if (holds(tree.folders, path) || tree.files.includes(path)) { block('A folder or file of this name is on Overleaf. Rename one of them.', mine); continue; }
    const parents = parentFolders(path), clash = parents.find(folder => !holds(tree.folders, folder) && (holds(tree.docs, folder) || tree.files.includes(folder)));
    if (clash) { block(`${clash} is a file on Overleaf, so its folder cannot be created.`, mine); continue; }
    rows.push({ path, kind: 'create', hash: mine.hash, size: mine.size, folders: parents.filter(folder => !holds(tree.folders, folder)) });
  }
  return rows;
}

/** The words of an outgoing row: `replaces Overleaf file · 120 KB → 134 KB`, `new on Overleaf · 134 KB · creates folder figures/`. */
export function outgoingSummary(picture: OutgoingPicture): string {
  const before = picture.remote?.size, after = picture.size;
  const sizes = before !== undefined && after !== undefined ? `${formatSize(before)} → ${formatSize(after)}` : after !== undefined ? formatSize(after) : before !== undefined ? formatSize(before) : '';
  const label: Record<OutgoingKind, string> = { replace: 'replaces Overleaf file', create: 'new on Overleaf', restore: 'puts back the file this Send replaced', delete: 'deleted from Overleaf', blocked: 'not sent' };
  return [label[picture.kind], sizes, picture.folders?.length ? `creates folder ${picture.folders.map(folder => `${folder}/`).join(', ')}` : ''].filter(Boolean).join(' · ');
}
