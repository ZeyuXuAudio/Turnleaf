import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectStore, turnleafIgnore } from '../src/core/projectStore';

const hasGit = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

async function folder(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'turnleaf-gitignore-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: new ProjectStore(root, 'https://overleaf.example', 'project', ['main.tex']) };
}

test('the store writes .turnleaf/.gitignore that ignores everything', async t => {
  const { root, store } = await folder(t);
  await store.init();
  assert.equal(await readFile(join(root, '.turnleaf/.gitignore'), 'utf8'), turnleafIgnore);
  assert.deepEqual(turnleafIgnore.split('\n').filter(line => line && !line.startsWith('#')), ['*']);
});

test('an edited .turnleaf/.gitignore is kept, a deleted one is written again', async t => {
  const { root, store } = await folder(t), path = join(root, '.turnleaf/.gitignore');
  await store.init();
  await writeFile(path, '# shared on purpose\n');
  await store.update(() => {});
  assert.equal(await readFile(path, 'utf8'), '# shared on purpose\n');
  await rm(path);
  await store.update(() => {});
  assert.equal(await readFile(path, 'utf8'), turnleafIgnore);
});

test('git status lists nothing under .turnleaf/ and Git metadata is untouched', { skip: !hasGit && 'git is not installed' }, async t => {
  const { root, store } = await folder(t);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '--quiet');
  await writeFile(join(root, 'main.tex'), 'Text.\n');
  const exclude = await readFile(join(root, '.git/info/exclude'), 'utf8').catch(() => undefined);
  await store.update(data => { data.revision = 'r1'; });
  await writeFile(await store.path('actions.jsonl'), '{}\n');
  assert.equal(git('status', '--porcelain', '--untracked-files=all'), '?? main.tex\n');
  git('add', '-A');
  assert.deepEqual(git('diff', '--cached', '--name-only').trim().split('\n'), ['main.tex']);
  assert.equal(await readFile(join(root, '.git/info/exclude'), 'utf8').catch(() => undefined), exclude);
});
