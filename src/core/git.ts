import { execFile } from 'node:child_process';
import { mkdtemp, rm, readFile, mkdir, appendFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SyncError } from './errors';
import { assertRepositoryLocks, withRepositoryLock } from './lock';

export class GitStore {
  private common?: Promise<string>;
  constructor(readonly root: string, readonly branch = 'overleaf') {}
  commonDirectory(): Promise<string> {
    return this.common ??= this.run(['rev-parse', '--git-common-dir']).then(path => realpath(resolve(this.root, path.trim())));
  }
  async exclusive<T>(action: () => Promise<T>): Promise<T> { return withRepositoryLock(await this.commonDirectory(), action); }
  async run(args: string[], input?: string | Buffer, env: NodeJS.ProcessEnv = {}): Promise<string> {
    assertRepositoryLocks();
    return new Promise((res, rej) => {
      const child = execFile('git', args, { cwd: this.root, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env }, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) rej(new SyncError(`Git ${args[0]} failed: ${stderr.trim() || error.message}`, 'git'));
        else res(stdout);
      });
      child.stdin?.on('error', () => {});
      child.stdin?.end(input);
    });
  }
  async optional(args: string[]): Promise<string | undefined> {
    try { return (await this.run(args)).trim(); } catch { return undefined; }
  }
  async init(): Promise<void> {
    const root = (await this.run(['rev-parse', '--show-toplevel'])).trim();
    if (await realpath(root) !== await realpath(this.root)) throw new SyncError('Open the Git repository root as the workspace folder.', 'git');
    await this.run(['check-ref-format', '--branch', this.branch]);
    if (this.branch.startsWith('-') || this.branch === 'HEAD') throw new SyncError('Choose a normal branch name for snapshots.', 'configuration');
    const worktrees = await this.run(['worktree', 'list', '--porcelain']);
    if (worktrees.split('\n').includes(`branch refs/heads/${this.branch}`)) throw new SyncError(`Snapshot branch ${this.branch} is checked out. Choose a dedicated, un-checked-out snapshot branch.`, 'git');
    await this.head();
    if (await this.optional(['rev-parse', '--verify', 'MERGE_HEAD'])) throw new SyncError('Finish or abort the current Git merge first.', 'git');
  }
  async head(): Promise<string> { return (await this.run(['rev-parse', '--verify', 'HEAD^{commit}'])).trim(); }
  async sourceBranch(): Promise<string> {
    const ref = await this.optional(['symbolic-ref', '--quiet', 'HEAD']);
    if (!ref?.startsWith('refs/heads/')) throw new SyncError('Switch to a local branch before synchronizing with Overleaf.', 'git');
    return ref;
  }
  async snapshot(): Promise<string | undefined> { return this.optional(['rev-parse', '--verify', `refs/heads/${this.branch}^{commit}`]); }
  async clean(): Promise<boolean> { return !(await this.run(['status', '--porcelain', '--untracked-files=all'])).trim(); }
  async requireClean(): Promise<void> { if (!await this.clean()) throw new SyncError('Commit or stash all changes, including untracked files, first.', 'git'); }
  async text(commit: string, path: string): Promise<string> { return this.run(['show', `${commit}:${path}`]); }
  async bytes(commit: string, path: string): Promise<Buffer> {
    const entry = await this.run(['--literal-pathspecs', 'ls-tree', '-z', commit, '--', path]);
    const match = /^(100644|100755) blob ([0-9a-f]+)\t([^\0]+)\0$/.exec(entry);
    if (!match || match[3] !== path) throw new SyncError(`${path}: uploads require a regular committed file. Symlinks, submodules and missing files cannot be uploaded.`, 'import');
    return new Promise((res, rej) => execFile('git', ['cat-file', 'blob', match[2]], { cwd: this.root, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 }, (e, out) => e ? rej(new SyncError(`Cannot read committed file ${path}.`, 'git')) : res(out)));
  }
  async matches(commit: string, texts: Record<string, string>): Promise<boolean> {
    for (const [path, text] of Object.entries(texts)) {
      const oid = (await this.run(['hash-object', '--stdin'], text)).trim();
      if (await this.optional(['rev-parse', '--verify', `${commit}:${path}`]) !== oid) return false;
    }
    return true;
  }
  async baseline(texts: Record<string, string>): Promise<string | undefined> {
    const paths = Object.keys(texts), hashes: string[] = [];
    for (const path of paths) hashes.push((await this.run(['hash-object', '--stdin'], texts[path])).trim());
    const commits = (await this.run(['rev-list', '--first-parent', '--max-count=500', 'HEAD'])).trim().split('\n');
    // Batch all lookups: no hundreds of subprocesses when first linking a project.
    const ids = (await this.run(['cat-file', '--batch-check=%(objectname)'], commits.flatMap(c => paths.map(p => `${c}:${p}`)).join('\n') + '\n')).trim().split('\n');
    return commits.find((_, i) => paths.every((__, j) => ids[i * paths.length + j] === hashes[j]));
  }
  async tree(base: string, texts: Record<string, string | null>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'overleaf-index-'));
    const env = { GIT_INDEX_FILE: join(dir, 'index') };
    try {
      await this.run(['read-tree', base], undefined, env);
      for (const [path, text] of Object.entries(texts)) {
        if (text === null) { await this.run(['--literal-pathspecs', 'update-index', '--force-remove', '--', path], undefined, env); continue; }
        const oid = (await this.run(['hash-object', '-w', '--stdin'], text)).trim();
        const existing = await this.run(['--literal-pathspecs', 'ls-tree', base, '--', path]);
        const mode = existing.startsWith('100755') ? '100755' : '100644';
        if (existing && !/^100(644|755) blob /.test(existing)) throw new SyncError(`Tracked file ${path} must be a regular file, not a symlink or submodule.`, 'git');
        await this.run(['update-index', '--add', '--cacheinfo', mode, oid, path], undefined, env);
      }
      return (await this.run(['write-tree'], undefined, env)).trim();
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  async checkpoint(texts: Record<string, string | null>, reason: string): Promise<string> {
    return this.exclusive(async () => {
      const head = await this.head(), tree = await this.tree(head, texts);
      const commit = (await this.run(['commit-tree', tree, '-p', head, '-m', `Overleaf ${reason} checkpoint ${new Date().toISOString()}`])).trim();
      const ref = `refs/turnleaf/checkpoints/${Date.now()}-${randomUUID()}`;
      await this.run(['update-ref', ref, commit]);
      return ref;
    });
  }
  async record(texts: Record<string, string>, baseline?: string, verifiedHead?: string, force = false, expectedSnapshot?: string | null): Promise<string> {
    return this.exclusive(async () => {
      const old = await this.snapshot();
      if (expectedSnapshot !== undefined && old !== (expectedSnapshot ?? undefined)) throw new SyncError('The snapshot changed during synchronization. Run Pull before retrying.', 'git');
      if (!old && !baseline) throw new SyncError('Choose the first-pull baseline before recording a snapshot.', 'git');
      if (!force && !verifiedHead && old && await this.matches(old, texts)) return old;
      const parent = old ?? baseline!;
      const tree = verifiedHead ? (await this.run(['rev-parse', `${verifiedHead}^{tree}`])).trim() : await this.tree(parent, texts);
      const parents = [...new Set([parent, ...(verifiedHead ? [verifiedHead] : [])])];
      const commit = (await this.run(['commit-tree', tree, ...parents.flatMap(p => ['-p', p]), '-m', `Overleaf snapshot ${new Date().toISOString()}`])).trim();
      await this.run(['update-ref', `refs/heads/${this.branch}`, commit, old ?? '0'.repeat(commit.length)]);
      return commit;
    });
  }
  async assertSnapshotScope(snapshot: string, paths: string[]): Promise<void> {
    const base = await this.optional(['merge-base', 'HEAD', snapshot]);
    if (!base) throw new SyncError('The snapshot has no shared history with this branch. Choose a new snapshotBranch and establish a baseline.', 'git');
    const changed = (await this.run(['diff', '--name-only', '--no-renames', '-z', base, snapshot])).split('\0').filter(Boolean);
    const unrelated = changed.filter(path => !paths.includes(path));
    if (unrelated.length) throw new SyncError(`Snapshot would merge files outside trackedFiles: ${unrelated.join(', ')}. Switch back to the linked author branch or choose a new snapshotBranch.`, 'git');
  }
  async merged(paths: string[]): Promise<boolean> {
    const snapshot = await this.snapshot();
    if (!snapshot) return false;
    const base = await this.optional(['merge-base', 'HEAD', snapshot]);
    return !!base && (await this.optional(['diff', '--quiet', base, snapshot, '--', ...paths])) !== undefined;
  }
  async exclude(paths: string[]): Promise<void> {
    return this.exclusive(async () => {
      const path = resolve(this.root, (await this.run(['rev-parse', '--git-path', 'info/exclude'])).trim());
      let contents = '';
      try { contents = await readFile(path, 'utf8'); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
      const missing = paths.filter(p => !contents.split('\n').includes(p));
      if (missing.length) { await mkdir(resolve(path, '..'), { recursive: true }); await appendFile(path, `\n${missing.join('\n')}\n`); }
    });
  }
  async stash(): Promise<{ oid: string; name: string } | undefined> {
    if (await this.clean()) return;
    const name = `turnleaf ${new Date().toISOString()} ${randomUUID()}`;
    await this.run(['stash', 'push', '--include-untracked', '-m', name]);
    const entries = (await this.run(['stash', 'list', '--format=%H%x09%gs'])).trim().split('\n').filter(line => line.endsWith(name));
    if (entries.length !== 1) throw new SyncError(`Could not identify the new stash ${name}; inspect git stash list before continuing.`, 'git');
    return { oid: entries[0].split('\t')[0], name };
  }
  async restore(stash: { oid: string; name: string }): Promise<void> {
    await this.run(['stash', 'apply', '--index', stash.oid]);
    const entries = (await this.run(['stash', 'list', '--format=%gd%x09%H%x09%gs'])).trim().split('\n').filter(line => line.split('\t')[1] === stash.oid && line.endsWith(stash.name));
    if (entries.length !== 1) throw new SyncError(`Changes restored. Stash ${stash.name} (${stash.oid}) retained because its selector is ambiguous.`, 'git');
    const selector = entries[0].split('\t')[0];
    if ((await this.optional(['rev-parse', selector])) !== stash.oid) throw new SyncError(`Changes restored; stash list changed, so ${stash.name} was retained.`, 'git');
    await this.run(['stash', 'drop', selector]);
  }
  async merge(snapshot: string, stashChanges = false, reconciled = false, paths?: string[], expectedBranch?: string): Promise<void> {
    return this.exclusive(async () => {
      if (expectedBranch && await this.sourceBranch() !== expectedBranch) throw new SyncError('The author branch changed. Run Pull again on the linked branch.', 'git');
      if (paths) await this.assertSnapshotScope(snapshot, paths);
      let stash: { oid: string; name: string } | undefined;
      try {
        if (stashChanges) stash = await this.stash();
        await this.requireClean();
        await this.run(['merge', '--no-ff', ...(reconciled ? ['-s', 'ours'] : []), snapshot, '-m', `${reconciled ? 'Overleaf baseline reconciled by hand' : 'Merge Overleaf snapshot'} ${new Date().toISOString()}`]);
        if (stash) await this.restore(stash);
      } catch (error) {
        throw new SyncError(`${error instanceof Error ? error.message : error}${stash ? `\nSaved stash retained: ${stash.name} (${stash.oid}).` : ''}`, 'git');
      }
    });
  }
}
