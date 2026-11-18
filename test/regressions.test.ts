import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm, symlink, mkdir, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { GitStore } from '../src/core/git';
import { LocalState, atomicJson } from '../src/core/storage';
import { SyncService, remoteTexts } from '../src/core/sync';
import { OverleafReader } from '../src/core/overleaf';
import { startFixtureServer, fixtureCookie } from './fixtureServer';
import { normalizeDoc } from '../src/core/docState';
import { composeEdits, diffText } from '../src/core/diff';
import { mapDocument } from '../src/core/ranges';
import { reviewRows, trackedInspection } from '../src/core/review';
import { ReviewComputer } from '../src/extension/reviewComputer';
import { withOperation } from '../src/core/operation';

async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'overleaf-regression-')), git = new GitStore(root);
  await git.run(['init', '-b', 'main']); await git.run(['config', 'user.name', 'Regression Test']); await git.run(['config', 'user.email', 'test@example.invalid']);
  const commit = async (files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) await writeFile(join(root, path), text);
    await git.run(['add', '.']); await git.run(['commit', '-m', 'test']); return git.head();
  };
  return { root, git, commit, close: () => rm(root, { recursive: true, force: true }) };
}
async function linked() {
  const fixture = await startFixtureServer({ writable: true }), repo = await repository();
  const reader = new OverleafReader(fixture.baseUrl, fixtureCookie), paths = ['main.tex', 'references.bib'];
  const inspection = await reader.inspect('test-project', paths), base = await repo.commit(remoteTexts(inspection));
  const state = new LocalState(repo.git, fixture.baseUrl, inspection.projectId, paths), service = new SyncService(repo.git, state, reader, inspection.projectId, paths);
  await repo.git.merge(await service.recordPull(inspection, base));
  return { ...repo, fixture, reader, state, service, inspection, close: async () => { await fixture.close(); await repo.close(); } };
}

test('committed symlinks are rejected before uploads or snapshot changes', async () => {
  const r = await linked();
  try {
    const before = await r.git.snapshot();
    await rm(join(r.root, 'references.bib')); await symlink('shared.bib', join(r.root, 'references.bib'));
    await r.commit({ 'shared.bib': 'local references\n' });
    await assert.rejects(r.service.preflight(), /regular committed file/);
    assert.equal(r.fixture.requests.filter(request => request.path.endsWith('/upload')).length, 0);
    assert.equal(await r.git.snapshot(), before);
    assert.equal(r.fixture.sockets.size, 0);
  } finally { await r.close(); }
});
test('a verified push cannot import feature-branch files after switching author branches', async () => {
  const r = await linked();
  try {
    await r.git.run(['branch', 'other']);
    await r.commit({ 'main.tex': r.inspection.docs[0].text + 'local\n', 'private-notes.txt': 'feature work\n' });
    await r.service.push(await r.service.preflight(), () => true, () => {});
    const snapshot = await r.git.snapshot(); await r.git.run(['checkout', 'other']);
    await assert.rejects(r.service.recordPull(await r.service.fetchPull()), /linked to main/);
    await assert.rejects(r.git.merge(snapshot!, false, false, r.service.paths), /outside trackedFiles: private-notes.txt/);
    await assert.rejects(readFile(join(r.root, 'private-notes.txt')), /ENOENT/);
    await r.git.run(['checkout', 'main']);
    await r.service.mergePull(snapshot!, false, await r.git.head(), await r.git.sourceBranch());
    assert.equal(await readFile(join(r.root, 'private-notes.txt'), 'utf8'), 'feature work\n');
  } finally { await r.close(); }
});
test('snapshot ownership survives cache deletion and is shared with linked worktrees', async () => {
  const r = await linked();
  const worktree = r.root + '-worktree';
  try {
    await rm(join(r.root, '.turnleaf/cache'), { recursive: true });
    assert.equal(await r.state.claimSnapshot(), 'refs/heads/main');
    assert.equal(await new LocalState(r.git, r.fixture.baseUrl, 'test-project', [...r.service.paths].reverse()).claimSnapshot(), 'refs/heads/main');
    await r.git.run(['worktree', 'add', '-b', 'alternate', worktree]);
    const other = new GitStore(worktree), state = new LocalState(other, r.fixture.baseUrl, 'test-project', r.service.paths);
    assert.equal(await other.commonDirectory(), await r.git.commonDirectory());
    await assert.rejects(state.claimSnapshot(), /linked to main/);
    await assert.rejects(new LocalState(other, r.fixture.baseUrl, 'wrong-project', r.service.paths).claimSnapshot(), /different project/);
  } finally { await r.git.run(['worktree', 'remove', '--force', worktree]).catch(() => {}); await r.close(); }
});
test('legacy snapshot links migrate safely; missing links require exact remote text verification', async () => {
  const r = await repository();
  try {
    const base = await r.commit({ 'main.tex': 'base\n' }), url = 'https://example.invalid', paths = ['main.tex'];
    const state = new LocalState(r.git, url, 'p', paths);
    await r.git.record({ 'main.tex': 'remote\n' }, base);
    await assert.rejects(state.claimSnapshot(), /Verify Snapshot Link/);
    await assert.rejects(state.claimSnapshot({ 'main.tex': 'wrong\n' }), /Verify Snapshot Link/);
    const key = createHash('sha256').update(JSON.stringify([url, 'p', paths, r.git.branch])).digest('hex');
    await atomicJson(await state.path('cache/snapshot-links.json'), { overleaf: key });
    await state.claimSnapshot();
    await rm(join(r.root, '.turnleaf/cache'), { recursive: true }); await state.claimSnapshot();
    await rm(join(await r.git.commonDirectory(), 'turnleaf'), { recursive: true });
    assert.equal(await state.claimSnapshot({ 'main.tex': 'remote\n' }), 'refs/heads/main');
  } finally { await r.close(); }
});
test('concurrent editor processes preserve every review update; abandoned locks recover', async () => {
  const r = await repository();
  try {
    await r.commit({ 'main.tex': 'base\n' });
    const execute = promisify(execFile);
    const script = `const {GitStore}=require(process.argv[2]); const {LocalState}=require(process.argv[3]); const state=new LocalState(new GitStore(process.argv[1]),'https://example.invalid','p',['main.tex']); state.setReview(process.argv[4],{status:'addressed',updated:'now'}).catch(e=>{console.error(e);process.exitCode=1;});`;
    await Promise.all(Array.from({ length: 6 }, (_, i) => execute(process.execPath, ['-e', script, r.root, require.resolve('../src/core/git'), require.resolve('../src/core/storage'), `thread-${i}`])));
    const state = new LocalState(r.git, 'https://example.invalid', 'p', ['main.tex']);
    assert.equal(Object.keys(await state.reviews()).length, 6);
    await Promise.all([state.updateCache(c => { c.partialPush = ['main.tex']; }), state.updateCache(c => { c.anchors.t = { path: 'main.tex', line: 1, excerpt: 'base' }; })]);
    const cache = await state.cache(); assert.deepEqual(cache.partialPush, ['main.tex']); assert(cache.anchors.t);
    const lock = join(await r.git.commonDirectory(), 'turnleaf.lock');
    await mkdir(lock); const old = new Date(Date.now() - 60_000); await utimes(lock, old, old);
    await state.setReview('recovered', { status: 'open', updated: 'now' });
    assert.equal(Object.keys(await state.reviews()).length, 7);
  } finally { await r.close(); }
});
test('undo restores history and legacy comment anchors while retaining other edits', () => {
  const docs = [
    normalizeDoc('main.tex', 'd', [{ content: 'abcdef', comments: [{ id: 't', ranges: [{ pos: 1, length: 1 }] }], trackedChanges: [] }, 1, [], {}, 'history-ot']),
    normalizeDoc('main.tex', 'd', [['abcdef'], 1, [], { comments: [{ op: { p: 1, c: 'b', t: 't' } }] }, 'sharejs-text-ot']),
  ];
  for (const doc of docs) {
    let diff = composeEdits(doc.text, [[0, doc.text]], [{ rangeOffset: 6, rangeLength: 0, text: '!' }]);
    diff = composeEdits(doc.text, diff, [{ rangeOffset: 1, rangeLength: 1, text: '' }]);
    diff = composeEdits(doc.text, diff, [{ rangeOffset: 1, rangeLength: 0, text: 'b' }]);
    assert.deepEqual(mapDocument(doc, 'abcdef!', false, diff).comments, mapDocument(doc, 'abcdef!', false).comments);
    assert.deepEqual(diff, [[0, 'abcdef'], [1, '!']]);
  }
});
test('push replaces the expired review session and waits for delayed upload notifications', async () => {
  const r = await linked();
  try {
    await r.commit({ 'main.tex': r.inspection.docs[0].text + 'local\n' });
    const plan = await r.service.preflight();
    assert.equal(r.fixture.sockets.size, 0, 'No idle socket is held during the review dialog');
    r.fixture.sockets.clear(); r.fixture.delayUploadEvents(150);
    const result = await r.service.push(plan, () => true, () => {});
    assert.deepEqual(result.mismatches, []); assert.deepEqual(result.warnings, []);
    assert.equal(result.updates.filter(update => update.meta?.source === 'upload').length, 1);
    assert.equal((await r.state.cache()).partialPush, undefined);
  } finally { await r.close(); }
});
test('interrupted upload is durably fenced before the remote request', async () => {
  const r = await linked();
  try {
    await r.commit({ 'main.tex': r.inspection.docs[0].text + 'local\n' });
    const original = r.reader.write.bind(r.reader);
    r.reader.write = async permit => {
      assert.deepEqual((await r.state.cache()).partialPush, []);
      await original(permit); throw new Error('simulated lost response');
    };
    await assert.rejects(r.service.push(await r.service.preflight(), () => true, () => {}), /Run Pull/);
    await assert.rejects(r.service.preflight(), /Previous push stopped/);
    assert.equal(r.fixture.requests.filter(request => request.path.endsWith('/upload')).length, 1);
  } finally { await r.close(); }
});
test('slow reads are cancellable and do not issue uploads', async () => {
  const fixture = await startFixtureServer();
  try {
    fixture.delayThreadReads(10_000);
    const reader = new OverleafReader(fixture.baseUrl, fixtureCookie), controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    try { await assert.rejects(withOperation({ signal: controller.signal, report() {} }, () => reader.inspect('test-project', ['main.tex'])), /cancelled/); }
    finally { clearTimeout(timer); }
    assert.equal(fixture.requests.filter(request => request.path.endsWith('/upload')).length, 0);
  } finally { await fixture.close(); }
});
test('large-document worker matches synchronous mapping and line indexing preserves boundaries', async () => {
  const computer = new ReviewComputer(require.resolve('../src/core/reviewWorker'));
  try {
    const text = 'abcdef\n'.repeat(40_000), doc = normalizeDoc('main.tex', 'd', [{ content: text, comments: [{ id: 't', ranges: [{ pos: 7, length: 3 }] }], trackedChanges: [] }, 1, [], {}, 'history-ot']);
    const local = 'prefix\n' + text, result = await computer.compute({ doc, local });
    assert.deepEqual(result.mapping, mapDocument(doc, local)); assert.deepEqual(result.diffs, diffText(text, local).diffs);
    const inspection = { projectId: 'p', projectName: 'p', fetchedAt: '', docs: [doc], threads: { t: { id: 't', resolved: false, messages: [] } }, missingFiles: [], unassignedThreadCount: 0 };
    const cache = { schema: 1 as const, anchors: { removed: { path: 'main.tex', line: 2, excerpt: '' } } };
    assert.equal(reviewRows(inspection, cache, { 'main.tex': local }, new Map([['main.tex', result.mapping]]))[0].line, 3);
    const before = JSON.stringify(inspection); trackedInspection(inspection, cache); assert.equal(JSON.stringify(inspection), before);
  } finally { computer.dispose(); }
});
