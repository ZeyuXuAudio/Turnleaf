import { readFile, mkdir, writeFile, rename, lstat } from 'node:fs/promises';
import { resolve, relative, dirname, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Inspection } from './models';
import { GitStore } from './git';
import { SyncError } from './errors';
import { assertRepositoryLocks } from './lock';

export interface KnownAnchor { path: string; line: number; excerpt: string; }
export interface Cache {
  schema: 1; inspection?: Inspection; anchors: Record<string, KnownAnchor>; reconciliation?: Inspection; partialPush?: string[];
  appliedSnapshot?: string;
  localApply?: { checkpoint: string; before: Record<string, string | null>; after: Record<string, string | null> };
}
export interface ReviewState { status: 'open' | 'addressed' | 'declined'; sha?: string; reason?: string; updated: string; }
export type Reviews = Record<string, ReviewState>;
interface SnapshotLink { schema: 1; key: string; sourceBranch: string; }

// Reject links as well as '..': generated files must stay inside this workspace.
export async function workspacePath(root: string, path: string): Promise<string> {
  const full = resolve(root, path), rel = relative(root, full);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.split(/[\\/]/).some(p => ['.git', '.vscode'].includes(p))) throw new SyncError(`Invalid workspace output path: ${path}`, 'configuration');
  let current = root;
  for (const part of rel.split(/[\\/]/)) {
    current = resolve(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new SyncError(`Refusing symbolic link: ${path}`, 'configuration'); }
    catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  }
  return full;
}
export async function atomicJson(path: string, data: unknown): Promise<void> {
  assertRepositoryLocks();
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  assertRepositoryLocks();
  await rename(temp, path);
}
export class LocalState {
  private readonly key: string;
  private readonly bindingKey: string;
  constructor(readonly git: GitStore, baseUrl: string, projectId: string, private readonly trackedFiles: string[]) {
    this.key = createHash('sha256').update(JSON.stringify([baseUrl, projectId, trackedFiles, git.branch])).digest('hex');
    this.bindingKey = createHash('sha256').update(JSON.stringify([baseUrl, projectId, [...trackedFiles].sort(), git.branch])).digest('hex');
  }
  exclusive<T>(action: () => Promise<T>): Promise<T> { return this.git.exclusive(action); }
  async path(file: string): Promise<string> { return workspacePath(this.git.root, `.turnleaf/${file}`); }
  async init(): Promise<void> { await this.git.exclude(['/.turnleaf/cache/', '/.turnleaf/writes.jsonl']); }
  private async linkPath(): Promise<string> {
    const name = createHash('sha256').update(this.git.branch).digest('hex');
    return workspacePath(await this.git.commonDirectory(), `turnleaf/${name}.json`);
  }
  async claimSnapshot(verifiedTexts?: Record<string, string>): Promise<string> {
    return this.git.exclusive(async () => {
      const sourceBranch = await this.git.sourceBranch(), path = await this.linkPath();
      let link: SnapshotLink | undefined;
      try { link = JSON.parse(await readFile(path, 'utf8')); }
      catch (error: any) { if (error.code !== 'ENOENT') throw new SyncError('Cannot read the snapshot link in Git metadata. Restore valid metadata before synchronizing.', 'configuration'); }
      if (link !== undefined && (!link || link.schema !== 1 || typeof link.key !== 'string' || typeof link.sourceBranch !== 'string' || !link.sourceBranch.startsWith('refs/heads/'))) throw new SyncError('Invalid snapshot ownership metadata. Restore the link before synchronizing.', 'configuration');
      if (link) {
        if (link.schema !== 1 || link.key !== this.bindingKey) throw new SyncError(`Snapshot branch ${this.git.branch} belongs to a different project or tracked-file selection. Choose a new snapshotBranch.`, 'configuration');
        if (link.sourceBranch !== sourceBranch) throw new SyncError(`Snapshot branch ${this.git.branch} is linked to ${link.sourceBranch.replace(/^refs\/heads\//, '')}. Switch back to that author branch or choose a new snapshotBranch.`, 'configuration');
      } else {
        const snapshot = await this.git.snapshot();
        if (snapshot) {
          const legacy = await this.read<Record<string, string>>('cache/snapshot-links.json', {});
          if (legacy[this.git.branch] !== this.key && (!verifiedTexts || !await this.git.matches(snapshot, verifiedTexts))) throw new SyncError(`Snapshot branch ${this.git.branch} has no verified project link. Run Verify Snapshot Link, or choose a new snapshotBranch.`, 'configuration');
          // Migration and explicit recovery must never bless unrelated branch changes.
          await this.git.assertSnapshotScope(snapshot, this.trackedFiles);
        }
        await atomicJson(path, { schema: 1, key: this.bindingKey, sourceBranch } satisfies SnapshotLink);
      }
      return sourceBranch;
    });
  }
  private async read<T>(file: string, fallback: T): Promise<T> {
    try { return JSON.parse(await readFile(await this.path(file), 'utf8')); }
    catch (e: any) { if (e.code === 'ENOENT') return fallback; throw new SyncError(`Cannot read ${file}. Restore valid JSON before continuing.`, 'cache'); }
  }
  async cache(): Promise<Cache> {
    const c = await this.read<Cache>(`cache/${this.key}.json`, { schema: 1, anchors: {} });
    if (c.schema !== 1 || !c.anchors || typeof c.anchors !== 'object') throw new SyncError('Unsupported Overleaf cache; refresh after removing the cache file.', 'cache');
    return c;
  }
  async save(cache: Cache): Promise<void> { await this.git.exclusive(async () => { await this.init(); await atomicJson(await this.path(`cache/${this.key}.json`), cache); }); }
  async updateCache(update: (cache: Cache) => void | Promise<void>): Promise<Cache> {
    return this.git.exclusive(async () => { const cache = await this.cache(); await update(cache); await this.save(cache); return cache; });
  }
  async reviews(): Promise<Reviews> { return this.read('review-state.json', {}); }
  async setReview(id: string, state: ReviewState): Promise<void> {
    await this.git.exclusive(async () => {
      const reviews = await this.reviews();
      Object.defineProperty(reviews, id, { value: state, enumerable: true, writable: true, configurable: true });
      await atomicJson(await this.path('review-state.json'), Object.fromEntries(Object.entries(reviews).sort(([a], [b]) => a.localeCompare(b))));
    });
  }
}
