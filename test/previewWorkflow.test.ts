import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GitStore } from '../src/core/git';
import { LocalState } from '../src/core/storage';
import { SyncService, remoteTexts } from '../src/core/sync';
import { ReviewWorkflow, sameRemote } from '../src/core/workflow';
import { readSaved } from '../src/core/savedFiles';
import { OverleafReader } from '../src/core/overleaf';
import { guardedWrite } from '../src/core/guard';
import { fixtureCookie, fixtureOwner, startFixtureServer } from './fixtureServer';

async function linked() {
  const fixture = await startFixtureServer({ writable: true }), root = await mkdtemp(join(tmpdir(), 'overleaf-preview-'));
  fixture.replies.modern[0] = { content: 'Rain was excluded.\n\nMethods.\n\nResults.\n\nDrift: 0.64.\n', comments: [{ id: 'c1', ranges: [{ pos: 0, length: 4 }] }], trackedChanges: [] };
  const git = new GitStore(root);
  await git.run(['init', '-b', 'main']); await git.run(['config', 'user.name', 'Preview Test']); await git.run(['config', 'user.email', 'preview@example.invalid']);
  const reader = new OverleafReader(fixture.baseUrl, fixtureCookie), paths = ['main.tex', 'references.bib'];
  const inspection = await reader.inspect('test-project', paths);
  for (const [path, text] of Object.entries(remoteTexts(inspection))) await writeFile(join(root, path), text);
  await writeFile(join(root, 'notes.txt'), 'unrelated baseline\n');
  await git.run(['add', '.']); await git.run(['commit', '-m', 'Shared baseline']);
  const state = new LocalState(git, fixture.baseUrl, 'test-project', paths), sync = new SyncService(git, state, reader, 'test-project', paths), workflow = new ReviewWorkflow(sync);
  const first = await workflow.preparePull();
  assert.equal(first.files.length, 0); assert.equal(await git.snapshot(), undefined, 'preview does not record a snapshot');
  await workflow.apply(first, () => true);
  return { root, git, fixture, reader, state, sync, workflow, inspection, paths,
    local: () => readSaved(root, paths, true),
    remoteEdit(text: string) { fixture.replies.modern[0].content = text; fixture.replies.modern[1]++; },
    close: async () => { await fixture.close(); await rm(root, { recursive: true, force: true }); } };
}

test('saved-file send uploads the reviewed bytes without committing or changing unrelated staged work', async () => {
  const r = await linked();
  try {
    const head = await r.git.head(), saved = r.inspection.docs[0].text + '\nA saved revision.\n';
    await writeFile(join(r.root, 'notes.txt'), 'unrelated staged work\n'); await r.git.run(['add', 'notes.txt']);
    await writeFile(join(r.root, 'scratch.txt'), 'untracked work\n');
    await writeFile(join(r.root, 'main.tex'), saved);
    const index = await r.git.run(['diff', '--cached']);
    const plan = await r.workflow.prepareSend();
    assert.equal(plan.files[0].text, saved); assert.notEqual(await r.git.text(head, 'main.tex'), saved);
    const result = await r.sync.push(plan, () => true, () => {});
    assert.deepEqual(result.mismatches, []); assert.equal(result.inspection.docs[0].text, saved);
    assert.equal(await r.git.head(), head); assert.equal(await r.git.run(['diff', '--cached']), index);
    assert.equal(await readFile(join(r.root, 'scratch.txt'), 'utf8'), 'untracked work\n');
    assert.equal((await r.state.cache()).appliedSnapshot, result.snapshot);
    assert((await r.git.run(['for-each-ref', '--format=%(refname)', 'refs/turnleaf/checkpoints/'])).trim());
    assert.equal((await r.workflow.prepareSend()).files.length, 0);
  } finally { await r.close(); }
});

test('saved changes, dirty-buffer guard, remote versions and new comments each reject a stale send', async () => {
  const r = await linked();
  try {
    const text = r.inspection.docs[0].text + '\nLocal revision.\n'; await writeFile(join(r.root, 'main.tex'), text);
    let plan = await r.workflow.prepareSend();
    await writeFile(join(r.root, 'main.tex'), text + 'newer\n');
    await assert.rejects(r.sync.push(plan, () => true, () => {}), /Saved files changed/);
    plan = await r.workflow.prepareSend(); await assert.rejects(r.sync.push(plan, () => false, () => {}), /disabled or an editor changed/);
    r.fixture.replies.modern[1]++;
    await assert.rejects(r.sync.push(plan, () => true, () => {}), /Overleaf changed/);
    plan = await r.workflow.prepareSend(); r.fixture.threads.c1.messages[0].content = 'New collaborator comment';
    await assert.rejects(r.sync.push(plan, () => true, () => {}), /Overleaf changed/);
    assert.equal(r.fixture.requests.filter(r => r.path.endsWith('/upload')).length, 0);
  } finally { await r.close(); }
});

test('incoming diff preserves local edits and applies exactly its proposed result without advancing the baseline on preview', async () => {
  const r = await linked();
  try {
    const base = r.inspection.docs[0].text, local = base.replace('Rain was excluded.', 'Rain was excluded using the gauge.');
    await writeFile(join(r.root, 'main.tex'), local); r.remoteEdit(base.replace('0.64', '0.62'));
    const snapshot = await r.git.snapshot(), head = await r.git.head(), index = await r.git.run(['write-tree']);
    const plan = await r.workflow.preparePull();
    assert.equal(await r.git.snapshot(), snapshot); assert.equal((await r.local())['main.tex'], local);
    assert.equal(plan.files[0].before, local); assert.match(plan.files[0].after, /using the gauge/); assert.match(plan.files[0].after, /0.62/); assert(!plan.files[0].conflict);
    await r.sync.refresh(); assert.equal(await r.git.snapshot(), snapshot, 'remote freshness does not advance baseline');
    const result = await r.workflow.apply(plan, () => true);
    assert.deepEqual(await r.local(), plan.proposed); assert.equal(await r.git.head(), head); assert.equal(await r.git.run(['write-tree']), index);
    assert.equal(await r.git.text(result.checkpoint, 'main.tex'), local);
    assert.equal((await r.workflow.preparePull()).files.length, 0);
    const send = await r.workflow.prepareSend(); assert.equal(send.files.length, 1); assert.match(send.files[0].text, /gauge/);
  } finally { await r.close(); }
});

test('incoming apply rejects new local, remote and branch changes without modifying source files', async () => {
  const r = await linked();
  try {
    r.remoteEdit(r.inspection.docs[0].text.replace('0.64', '0.62'));
    const plan = await r.workflow.preparePull(), before = await r.local(), snapshot = await r.git.snapshot();
    await assert.rejects(r.workflow.apply(plan, () => false), /Local contents/);
    r.remoteEdit(r.inspection.docs[0].text.replace('0.64', '0.60'));
    await assert.rejects(r.workflow.apply(plan, () => true), /Overleaf changed/);
    assert.deepEqual(await r.local(), before); assert.equal(await r.git.snapshot(), snapshot);
    const fresh = await r.workflow.preparePull(); await r.git.run(['checkout', '-b', 'other']);
    await assert.rejects(r.workflow.apply(fresh, () => true), /linked to main/);
  } finally { await r.close(); }
});

test('identical edits on both sides converge without a conflict or a redundant upload', async () => {
  const r = await linked();
  try {
    const text = r.inspection.docs[0].text.replace('0.64', '0.62');
    await writeFile(join(r.root, 'main.tex'), text); r.remoteEdit(text);
    const plan = await r.workflow.preparePull();
    assert.equal(plan.files.length, 0);
    await r.workflow.apply(plan, () => true);
    assert.equal((await r.local())['main.tex'], text);
    assert.equal((await r.workflow.prepareSend()).files.length, 0);
    assert.equal(r.fixture.requests.filter(request => request.path.endsWith('/upload')).length, 0);
  } finally { await r.close(); }
});

test('simultaneous edits to different files preserve the local revision through pull and send', async () => {
  const r = await linked();
  try {
    const localMain = r.inspection.docs[0].text + '\nLocal discussion.\n';
    const remoteBib = 'A collaborator bibliography revision.\n';
    await writeFile(join(r.root, 'main.tex'), localMain);
    r.fixture.replies.legacy[0] = remoteBib.split('\n'); r.fixture.replies.legacy[1]++;
    const incoming = await r.workflow.preparePull();
    assert.deepEqual(incoming.files.map(file => file.path), ['references.bib']);
    assert.equal(incoming.proposed['main.tex'], localMain);
    await r.workflow.apply(incoming, () => true);
    const outgoing = await r.workflow.prepareSend();
    assert.deepEqual(outgoing.files.map(file => file.doc.path), ['main.tex']);
    const result = await r.sync.push(outgoing, () => true, () => {});
    assert.deepEqual(result.mismatches, []);
    assert.deepEqual(remoteTexts(result.inspection), { 'main.tex': localMain, 'references.bib': remoteBib });
    assert.deepEqual(await r.local(), remoteTexts(result.inspection));
  } finally { await r.close(); }
});

// A gate gives the edit a precise place inside the asynchronous operation.
// It does not depend on a timer racing a fixture-server request.
function readGate() {
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const resumed = new Promise<void>(resolve => { release = resolve; });
  return { waiting, release, async pause() { entered(); await resumed; } };
}

test('a saved local edit during the final incoming read prevents apply and preserves that edit', async () => {
  const r = await linked(), gate = readGate();
  try {
    r.remoteEdit(r.inspection.docs[0].text.replace('0.64', '0.62'));
    const plan = await r.workflow.preparePull(), snapshot = await r.git.snapshot();
    const fetch = r.sync.fetchPull.bind(r.sync);
    r.sync.fetchPull = async () => { const result = await fetch(); await gate.pause(); return result; };
    const rejected = assert.rejects(r.workflow.apply(plan, () => true), /Local contents or Git changed/);
    await gate.waiting;
    const newerLocal = r.inspection.docs[0].text + '\nTyped while checking Overleaf.\n';
    await writeFile(join(r.root, 'main.tex'), newerLocal); gate.release();
    await rejected;
    assert.equal((await r.local())['main.tex'], newerLocal);
    assert.equal(await r.git.snapshot(), snapshot);
    assert.equal((await r.state.cache()).localApply, undefined);
  } finally { gate.release(); await r.close(); }
});

test('a saved local edit during send preflight prevents every upload', async () => {
  const r = await linked(), gate = readGate();
  try {
    const text = r.inspection.docs[0].text + '\nReviewed local revision.\n';
    await writeFile(join(r.root, 'main.tex'), text);
    const plan = await r.workflow.prepareSend(), snapshot = await r.git.snapshot();
    const openSession = r.reader.openSession.bind(r.reader);
    r.reader.openSession = async (...args) => { const session = await openSession(...args); await gate.pause(); return session; };
    const rejected = assert.rejects(r.sync.push(plan, () => true, () => {}), /Saved files changed/);
    await gate.waiting;
    await writeFile(join(r.root, 'main.tex'), text + 'A newer saved edit.\n'); gate.release();
    await rejected;
    assert.equal(r.fixture.requests.filter(request => request.path.endsWith('/upload')).length, 0);
    assert.equal(r.fixture.replies.modern[0].content, r.inspection.docs[0].text);
    assert.equal(await r.git.snapshot(), snapshot);
    assert.equal((await r.state.cache()).partialPush, undefined);
    assert.equal(r.fixture.sockets.size, 0);
  } finally { gate.release(); await r.close(); }
});

test('conflict resolution stays in the preview until explicitly applied', async () => {
  const r = await linked();
  try {
    const base = r.inspection.docs[0].text, local = base.replace('0.64', '0.70');
    await writeFile(join(r.root, 'main.tex'), local); r.remoteEdit(base.replace('0.64', '0.62'));
    const plan = await r.workflow.preparePull(); assert(plan.files[0].conflict);
    await assert.rejects(r.workflow.apply(plan, () => true), /Resolve every conflict/);
    assert.throws(() => r.workflow.resolve(plan, 'main.tex', plan.files[0].after), /conflict markers/);
    const resolved = r.workflow.resolve(plan, 'main.tex', base.replace('0.64', '0.63'));
    assert.equal((await r.local())['main.tex'], local); assert(plan.files[0].conflict);
    await r.workflow.apply(resolved, () => true); assert.deepEqual(await r.local(), resolved.proposed);
  } finally { await r.close(); }
});

test('interrupted local apply retains a checkpoint and refuses recovery over subsequently edited files', async () => {
  const r = await linked();
  try {
    r.remoteEdit(r.inspection.docs[0].text.replace('0.64', '0.62')); const before = await r.local();
    const plan = await r.workflow.preparePull(), record = r.git.record.bind(r.git);
    r.git.record = async () => { throw new Error('simulated disk failure after file updates'); };
    await assert.rejects(r.workflow.apply(plan, () => true), /Recover Local Apply/); r.git.record = record;
    const journal = (await r.state.cache()).localApply; assert(journal); assert.deepEqual(await r.local(), plan.proposed);
    await assert.rejects(r.workflow.prepareSend(), /Recover the interrupted/);
    await writeFile(join(r.root, 'main.tex'), 'new work after interruption\n');
    await assert.rejects(r.workflow.recover(() => true), /changed after/);
    assert.equal((await r.local())['main.tex'], 'new work after interruption\n');
    await writeFile(join(r.root, 'main.tex'), plan.proposed['main.tex']!); await r.workflow.recover(() => true);
    assert.deepEqual(await r.local(), before); assert.equal((await r.state.cache()).localApply, undefined);
  } finally { await r.close(); }
});

test('missing local sources can be previewed and restored; symlinks cannot be sent', async () => {
  const r = await linked();
  try {
    await rm(join(r.root, 'main.tex')); const plan = await r.workflow.preparePull(); assert.equal(plan.saved['main.tex'], null);
    await r.workflow.apply(plan, () => true); assert.equal((await r.local())['main.tex'], r.inspection.docs[0].text);
    await rm(join(r.root, 'main.tex')); await symlink('notes.txt', join(r.root, 'main.tex'));
    await assert.rejects(r.workflow.prepareSend(), /symbolic link/);
  } finally { await r.close(); }
});

test('comment identity and guarded edit/delete routes match the authenticated author', async () => {
  const r = await linked();
  try {
    assert.equal(r.inspection.threads.c1.messages[0].authorId, fixtureOwner);
    assert.deepEqual(await r.reader.listSourceFiles('test-project'), { paths: ['main.tex', 'references.bib'], rootDoc: 'main.tex' });
    const mutate = (kind: 'editMessage' | 'deleteMessage' | 'deleteThread', threadId: string, messageId?: string) => guardedWrite(r.state, { kind, projectId: 'test-project', threadId, messageId, docId: 'modern', text: 'Edited from VS Code' }, () => true, async () => true, p => r.reader.write(p), () => {});
    await mutate('editMessage', 'c1', 'c1-m1'); assert.equal(r.fixture.threads.c1.messages[0].content, 'Edited from VS Code');
    await assert.rejects(mutate('deleteMessage', 'c2', 'c2-m1'), /403/);
    assert.equal(r.fixture.requests.filter(r => r.method === 'DELETE' && r.path.includes('c2-m1')).length, 1, 'forbidden writes are not retried');
    await mutate('deleteMessage', 'c1', 'c1-m1'); assert.equal(r.fixture.threads.c1.messages.length, 0);
    await mutate('deleteThread', 'c1'); assert.equal(r.fixture.threads.c1, undefined);
    const fresh = await r.reader.inspect('test-project', r.paths); assert(!sameRemote(r.inspection, fresh, { schema: 1, anchors: {} }));
  } finally { await r.close(); }
});
