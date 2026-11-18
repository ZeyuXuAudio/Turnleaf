import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ProjectStore, carrySelection } from '../src/core/projectStore';
import { ReviewWorkflow, SyncService, remoteTexts, planDifferences, irreversible, pushReport } from '../src/core/folderWorkflow';
import { OverleafReader } from '../src/core/overleaf';
import { fixtureCookie, startFixtureServer } from './fixtureServer';

const base = ['main.tex', 'references.bib'], withNew = [...base, 'sections/results.tex'];

// A linked folder whose selected files equal Overleaf, plus a local-only sections/results.tex.
async function project(options: { trackChanges?: boolean } = {}) {
  const fixture = await startFixtureServer({ writable: true, trackChanges: options.trackChanges ?? true }), root = await mkdtemp(join(tmpdir(), 'overleaf-newfile-'));
  const reader = new OverleafReader(fixture.baseUrl, fixtureCookie), inspection = await reader.inspect('test-project', base);
  for (const [path, text] of Object.entries(remoteTexts(inspection))) await writeFile(join(root, path), text);
  await mkdir(join(root, 'sections')); await writeFile(join(root, 'sections/results.tex'), 'Results.\nDrift: 0.64.\n');
  const open = (paths: string[]) => { const state = new ProjectStore(root, fixture.baseUrl, 'test-project', paths), sync = new SyncService(state, reader); return { state, sync, workflow: new ReviewWorkflow(sync) }; };
  const folder = (name: string) => fixture.tree.folders.find((item: any) => item.name === name);
  const created = () => folder('sections')?.docs.find((doc: any) => doc.name === 'results.tex');
  const writes = async (state: ProjectStore) => (await readFile(await state.path('writes.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.result === 'ok').map(entry => `${entry.action}:${entry.file}`);
  return { fixture, root, reader, inspection, open, folder, created, writes,
    async linkAll(paths = withNew) { const side = open(paths); await side.workflow.apply(await side.workflow.preparePull(), () => true); return side; },
    close: async () => { await fixture.close(); await rm(root, { recursive: true, force: true }); } };
}

test('a local-only file is listed as new on Overleaf and Send creates it, with its folder, untracked', async () => {
  const p = await project();
  try {
    const { state, sync, workflow } = await p.linkAll();
    const plan = await workflow.prepareSend();
    assert.deepEqual(plan.files.map(file => [file.doc.path, file.create?.folders, file.added]), [['sections/results.tex', ['sections'], 2]]);
    assert.equal(plan.incoming, undefined);
    assert.deepEqual(irreversible(plan), {});
    assert.match(pushReport(plan), /sections\/results\.tex: \+2 \/ −0 · new on Overleaf, creates folder sections/);
    const result = await sync.push(plan, () => true, () => {});
    const doc = p.created();
    assert(doc, 'created in the sections folder');
    assert.equal(p.fixture.replies[doc._id][0].content, 'Results.\nDrift: 0.64.\n');
    // Track Changes is on, but the new file's content is not a suggestion.
    assert.deepEqual(p.fixture.replies[doc._id][0].trackedChanges ?? [], []);
    assert.deepEqual(await p.writes(state), ['createFolder:sections', 'createDoc:sections/results.tex', 'edit:sections/results.tex']);
    assert.equal(remoteTexts(result.inspection)['sections/results.tex'], 'Results.\nDrift: 0.64.\n');
    assert.equal(result.inspection.docs.find(item => item.path === 'sections/results.tex')!.changes.length, 0);
    const [record] = await state.history();
    assert.equal(record.outcome, 'success');
    assert.deepEqual(record.sent?.created?.['sections/results.tex'], { docId: doc._id, folders: [{ path: 'sections', id: p.folder('sections')._id }] });
    assert.deepEqual(record.files.map(file => [file.path, file.before]), [['sections/results.tex', '']]);
    // Now synchronized: nothing goes out, and the file has a baseline.
    assert.equal((await workflow.prepareSend()).files.length, 0);
    assert((await state.read()).acknowledged?.docs.some(item => item.path === 'sections/results.tex'));
  } finally { await p.close(); }
});

test('a new file in an existing folder creates no folder; an empty new file is still created', async () => {
  const p = await project();
  try {
    p.fixture.addEntry('sections/intro.tex', 'doc', 'Intro.\n');
    await writeFile(join(p.root, 'sections/intro.tex'), 'Intro.\n');
    await writeFile(join(p.root, 'sections/results.tex'), '');
    const { state, sync, workflow } = await p.linkAll([...withNew, 'sections/intro.tex']);
    const plan = await workflow.prepareSend();
    assert.deepEqual(plan.files.map(file => [file.doc.path, file.create?.folders]), [['sections/results.tex', []]]);
    await sync.push(plan, () => true, () => {});
    assert.equal(p.fixture.replies[p.created()._id][0].content, '');
    assert.deepEqual(await p.writes(state), ['createDoc:sections/results.tex']);
  } finally { await p.close(); }
});

test('adding a local file to the selection keeps the baseline and queued comment changes', async () => {
  const p = await project();
  try {
    const old = await p.linkAll(base);
    const draft = { id: randomUUID(), kind: 'reply' as const, path: 'main.tex', docId: 'modern', threadId: 'c1', text: 'Fixed.', before: structuredClone(p.inspection.threads.c1), created: new Date().toISOString() };
    await old.state.queue(draft);
    await writeFile(join(p.root, 'main.tex'), p.inspection.docs[0].text + 'Local addition.\n');
    assert.equal(await carrySelection(p.root, p.fixture.baseUrl, 'test-project', base, withNew), 'copied');
    const next = p.open(withNew), data = await next.state.read();
    assert.deepEqual(data.pending.map(item => item.id), [draft.id]);
    assert.equal(data.revision, (await old.state.read()).revision);
    // No Get latest needed: the edit, the new file and the reply go out together.
    const plan = await next.workflow.prepareSend();
    assert.equal(plan.incoming, undefined);
    assert.deepEqual(plan.files.map(file => [file.doc.path, !!file.create]), [['main.tex', false], ['sections/results.tex', true]]);
    assert.equal(plan.comments.length, 1);
    await next.sync.push(plan, () => true, () => {});
    assert(p.created());
    assert.equal((await next.workflow.prepareSend()).files.length, 0);
    // The old partition is left as it was; a second carry finds the new one in place.
    assert.deepEqual((await old.state.read()).pending.map(item => item.id), [draft.id]);
    assert.equal(await carrySelection(p.root, p.fixture.baseUrl, 'test-project', base, withNew), 'none');
    assert.equal(await carrySelection(p.root, p.fixture.baseUrl, 'test-project', withNew, base), 'none');
  } finally { await p.close(); }
});

test('the selection does not grow over an interrupted sync', async () => {
  const p = await project();
  try {
    const old = await p.linkAll(base);
    await old.state.update(data => { data.partialSend = { history: 'h', confirmed: [], uncertain: ['file:main.tex'] }; });
    await assert.rejects(carrySelection(p.root, p.fixture.baseUrl, 'test-project', base, withNew), /Finish the interrupted sync/);
  } finally { await p.close(); }
});

test('a same-named file on Overleaf before the write stops Send with nothing written', async () => {
  const p = await project();
  try {
    const { state, sync, workflow } = await p.linkAll();
    const plan = await workflow.prepareSend(), original = p.reader.projectTree.bind(p.reader);
    p.reader.projectTree = async id => { p.reader.projectTree = original; p.fixture.addEntry('sections/results.tex', 'doc', 'Theirs.\n'); return original(id); };
    await assert.rejects(sync.push(plan, () => true, () => {}), /now exists on Overleaf\. Get latest/);
    assert.equal((await state.read()).partialSend, undefined);
    assert.equal(p.fixture.replies[p.created()._id][0].content, 'Theirs.\n');
    // Get latest then offers the choice for a file without a shared version.
    const pull = await workflow.preparePull();
    assert.deepEqual(pull.files.map(file => [file.path, file.conflict, file.firstSync]), [['sections/results.tex', true, true]]);
  } finally { await p.close(); }
});

test('Overleaf refusing a name that appeared at the create request writes nothing and is not uncertain', async () => {
  const p = await project();
  try {
    await mkdir(join(p.root, 'sections'), { recursive: true });
    const { state, sync, workflow } = await p.linkAll();
    p.fixture.addEntry('sections/other.tex', 'doc', 'x');
    const plan = await workflow.prepareSend();
    assert.deepEqual(plan.files[0].create, { folders: [] });
    const original = p.reader.projectTree.bind(p.reader);
    // The tree read before creating misses the coauthor's file; the server then refuses the name.
    p.reader.projectTree = async id => { p.reader.projectTree = original; const tree = await original(id); p.fixture.addEntry('sections/results.tex', 'doc', 'Theirs.\n'); return tree; };
    await assert.rejects(sync.push(plan, () => true, () => {}), /results\.tex now exists on Overleaf\. Get latest/);
    assert.equal((await state.read()).partialSend, undefined);
    const [record] = await state.history();
    assert.equal(record.outcome, 'stale');
  } finally { await p.close(); }
});

test('an unclear answer to creating a file is uncertain, never retried, and recovered through Keep my version', async () => {
  const p = await project();
  try {
    await writeFile(join(p.root, 'notes.tex'), 'Notes.\n');
    const paths = [...base, 'notes.tex'], { state, sync, workflow } = await p.linkAll(paths);
    p.fixture.failCreate('notes.tex', 'after');
    await assert.rejects(sync.push(await workflow.prepareSend(), () => true, () => {}), /now exists on Overleaf: created by a coauthor in the same moment, or by this Send without a clear answer/);
    const data = await state.read();
    assert.deepEqual(data.partialSend?.uncertain, ['create:notes.tex']);
    assert.equal((await state.history())[0].outcome, 'uncertain');
    // Send stays blocked until Get latest; the empty file then has no shared version.
    assert.equal((await workflow.planSend(data, data.observed ?? data.acknowledged!, { 'main.tex': '', 'references.bib': '', 'notes.tex': 'Notes.\n' })).blocked?.way, 'getLatest');
    const pull = await workflow.preparePull();
    assert.deepEqual(pull.files.map(file => [file.path, file.firstSync]), [['notes.tex', true]]);
    await workflow.apply(workflow.resolve(pull, 'notes.tex', 'Notes.\n'), () => true);
    const again = await workflow.prepareSend();
    assert.deepEqual(again.files.map(file => [file.doc.path, !!file.create, file.added]), [['notes.tex', false, 1]]);
    await sync.push(again, () => true, () => {});
    assert.equal(Object.values(p.fixture.replies).filter((reply: any) => reply[0]?.content === 'Notes.\n').length, 1);
  } finally { await p.close(); }
});

test('a create refused without an entry on Overleaf reports that nothing was created', async () => {
  const p = await project();
  try {
    await writeFile(join(p.root, 'notes.tex'), 'Notes.\n');
    const { state, sync, workflow } = await p.linkAll([...base, 'notes.tex']);
    p.fixture.failCreate('notes.tex', 'refuse');
    await assert.rejects(sync.push(await workflow.prepareSend(), () => true, () => {}), /Overleaf did not create notes\.tex .*Nothing was created for it/);
    assert.equal((await state.read()).partialSend, undefined);
    assert.equal((await state.history())[0].outcome, 'failed');
    assert.equal((await workflow.prepareSend()).files[0].create?.folders.length, 0);
  } finally { await p.close(); }
});

test('an unclear create answer stays uncertain although Overleaf shows no entry; Get latest then lets Send create it once', async () => {
  const p = await project();
  try {
    await writeFile(join(p.root, 'notes.tex'), 'Notes.\n');
    const paths = [...base, 'notes.tex'], { state, sync, workflow } = await p.linkAll(paths);
    p.fixture.failCreate('notes.tex', 'before');
    await assert.rejects(sync.push(await workflow.prepareSend(), () => true, () => {}), /without a clear answer/);
    assert.deepEqual((await state.read()).partialSend?.uncertain, ['create:notes.tex']);
    assert.equal((await state.history())[0].outcome, 'uncertain');
    await assert.rejects(workflow.prepareSend(), /Get latest to review the interrupted send/);
    const pull = await workflow.preparePull();
    assert.deepEqual(pull.files, []);
    await workflow.apply(pull, () => true);
    p.fixture.failCreate('', 'before');
    await sync.push(await workflow.prepareSend(), () => true, () => {});
    assert.equal(Object.values(p.fixture.replies).filter((reply: any) => reply[0]?.content === 'Notes.\n').length, 1);
  } finally { await p.close(); }
});

test('a created file that is not at its first version stops before its content is written', async () => {
  const p = await project();
  try {
    const { state, sync, workflow } = await p.linkAll();
    const write = p.reader.write.bind(p.reader);
    p.reader.write = async (permit, live) => { const id = await write(permit, live); if (permit.action.kind === 'createDoc') p.fixture.replies[id as string][1] = 3; return id; };
    await assert.rejects(sync.push(await workflow.prepareSend(), () => true, () => {}), /changed on Overleaf right after creating it/);
    assert.equal(p.created() && p.fixture.replies[p.created()._id][0].content, '');
    assert(!(await p.writes(state)).includes('edit:sections/results.tex'));
  } finally { await p.close(); }
});

test('a folder that vanished after the summary is not created without review', async () => {
  const p = await project();
  try {
    p.fixture.addEntry('sections/other.tex', 'doc', 'x');
    const { state, sync, workflow } = await p.linkAll();
    const plan = await workflow.prepareSend();
    assert.deepEqual(plan.files[0].create, { folders: [] });
    p.fixture.tree.folders = p.fixture.tree.folders.filter((folder: any) => folder.name !== 'sections');
    await assert.rejects(sync.push(plan, () => true, () => {}), /The folder sections is no longer on Overleaf, so sections\/results\.tex needs a folder that the summary did not show/);
    assert(!(await p.writes(state).catch(() => [] as string[])).some(write => write.startsWith('create')), 'nothing was written');
  } finally { await p.close(); }
});

test('a file deleted on Overleaf since the last sync is not created again', async () => {
  const p = await project();
  try {
    const { workflow, state } = await p.linkAll(base);
    p.fixture.tree.docs = p.fixture.tree.docs.filter((doc: any) => doc._id !== 'legacy');
    await assert.rejects(workflow.preparePull(), /references\.bib was deleted or renamed on Overleaf since your last sync\. Send does not bring it back/);
    const data = await state.read(), fresh = await p.reader.inspect('test-project', base);
    const result = await workflow.planSend(data, fresh, { 'main.tex': p.inspection.docs[0].text, 'references.bib': 'x' });
    assert.equal(result.blocked?.code, 'missing'); assert.match(result.blocked!.message, /deleted or renamed on Overleaf/);
  } finally { await p.close(); }
});

test('a selected file missing on both sides, or present on Overleaf as a non-text file, blocks with the reason', async () => {
  const p = await project();
  try {
    await rm(join(p.root, 'sections/results.tex'));
    await assert.rejects(p.open(withNew).workflow.preparePull(), /sections\/results\.tex is missing in the local folder and on Overleaf/);
    await writeFile(join(p.root, 'sections/results.tex'), 'Results.\n');
    p.fixture.addEntry('sections/results.tex', 'file');
    await assert.rejects(p.open(withNew).workflow.preparePull(), /exists on Overleaf, but not as a text file/);
  } finally { await p.close(); }
});

test('Undo this send deletes an untouched created file and keeps the folder it created; the local file is new again', async () => {
  const p = await project();
  try {
    const { state, sync, workflow } = await p.linkAll();
    await sync.push(await workflow.prepareSend(), () => true, () => {});
    const [record] = await state.history(), undo = await workflow.prepareUndo(record.id);
    assert.deepEqual(undo.files.map(file => [file.path, file.removed]), [['sections/results.tex', 2]]);
    assert.match(undo.files[0].note!, /Deletes this file from Overleaf, which this Send created; the folder sections that it created stays/);
    assert.deepEqual(undo.stays, []);
    assert.deepEqual(planDifferences(undo.plan, (await workflow.prepareUndo(record.id)).plan), []);
    await sync.push(undo.plan, () => true, () => {});
    assert.deepEqual(p.folder('sections').docs, []);
    assert.equal(await readFile(join(p.root, 'sections/results.tex'), 'utf8'), 'Results.\nDrift: 0.64.\n');
    assert.deepEqual((await p.writes(state)).slice(-1), ['deleteDoc:sections/results.tex']);
    const [undone] = await state.history(record.id);
    assert(undone.undoneBy);
    const again = await workflow.prepareSend();
    assert.deepEqual(again.files.map(file => [file.doc.path, file.create?.folders]), [['sections/results.tex', []]]);
  } finally { await p.close(); }
});

test('Undo this send does not delete a created file that a coauthor edits in the last moment', async () => {
  const p = await project();
  try {
    const { state, sync, workflow } = await p.linkAll();
    await sync.push(await workflow.prepareSend(), () => true, () => {});
    const [record] = await state.history(), undo = await workflow.prepareUndo(record.id), id = p.created()._id;
    // The edit arrives on the live connection after the checks read the file.
    const tree = p.reader.projectTree.bind(p.reader);
    p.reader.projectTree = async project => { const result = await tree(project); p.fixture.emit('otUpdateApplied', [{ doc: id, v: 100, op: [] }]); await new Promise(resolve => setTimeout(resolve, 100)); return result; };
    await assert.rejects(sync.push(undo.plan, () => true, () => {}), /sections\/results\.tex was edited on Overleaf just now, so it was not deleted/);
    assert(p.created());
    assert(!(await p.writes(state)).includes('deleteDoc:sections/results.tex'));
    assert.equal((await state.history())[0].outcome, 'stale');
  } finally { await p.close(); }
});

test('an Undo interrupted after deleting the created file is recovered by Get latest', async () => {
  const p = await project();
  try {
    await writeFile(join(p.root, 'sections/methods.tex'), 'Methods.\n');
    const paths = [...withNew, 'sections/methods.tex'], { state, sync, workflow } = await p.linkAll(paths);
    await sync.push(await workflow.prepareSend(), () => true, () => {});
    const [record] = await state.history(), undo = await workflow.prepareUndo(record.id);
    assert.equal(undo.files.length, 2);
    // The first deletion goes through; the second gets no clear answer.
    const write = p.reader.write.bind(p.reader);
    let deletions = 0;
    p.reader.write = async (permit, live) => { if (permit.action.kind === 'deleteDoc' && ++deletions === 2) throw new Error('connection reset'); return write(permit, live); };
    await assert.rejects(sync.push(undo.plan, () => true, () => {}));
    p.reader.write = write;
    const [first, second] = undo.files.map(file => file.path), journal = (await state.read()).partialSend!;
    assert.deepEqual([journal.confirmed.includes(`delete:${first}`), journal.uncertain], [true, [`delete:${second}`]]);
    // Not a coauthor's deletion: Get latest goes through; the deleted file is new on Overleaf again.
    await workflow.apply(await workflow.preparePull(), () => true);
    const again = await workflow.prepareSend();
    assert.deepEqual(again.files.map(file => [file.doc.path, !!file.create]), [[first, true]]);
  } finally { await p.close(); }
});

test('growing to a selection used before replaces its older state and keeps it aside; a newer one is kept', async () => {
  const p = await project();
  try {
    const big = await p.linkAll(withNew), small = await p.linkAll(base);
    const draft = { id: randomUUID(), kind: 'reply' as const, path: 'main.tex', docId: 'modern', threadId: 'c1', text: 'Fixed.', before: structuredClone(p.inspection.threads.c1), created: new Date().toISOString() };
    await big.state.queue(draft);
    // The smaller selection synced last: its state wins, the older one is moved aside.
    assert.equal(await carrySelection(p.root, p.fixture.baseUrl, 'test-project', base, withNew), 'copied');
    assert.deepEqual((await p.open(withNew).state.read()).pending, []);
    const { readdir } = await import('node:fs/promises');
    assert.equal((await readdir(join(p.root, '.turnleaf/projects'))).filter(name => name.startsWith(big.state.key + '.replaced-')).length, 1);
    assert(!(await readdir(join(p.root, '.turnleaf/projects'))).some(name => name.includes('.partial-')));
    // The larger selection synced last: it is kept as it is.
    await p.open(withNew).workflow.apply(await p.open(withNew).workflow.preparePull(), () => true);
    assert.equal(await carrySelection(p.root, p.fixture.baseUrl, 'test-project', base, withNew), 'none');
    // An interrupted sync in the smaller selection is refused even when the larger one exists.
    await small.state.update(data => { data.partialSend = { history: 'h', confirmed: [], uncertain: ['file:main.tex'] }; });
    await assert.rejects(carrySelection(p.root, p.fixture.baseUrl, 'test-project', base, withNew), /Finish the interrupted sync/);
  } finally { await p.close(); }
});

test('Undo this send keeps a created file that was edited or commented on Overleaf', async () => {
  const p = await project();
  try {
    const { state, sync, workflow } = await p.linkAll();
    await sync.push(await workflow.prepareSend(), () => true, () => {});
    const [record] = await state.history(), id = p.created()._id;
    p.fixture.replies[id][0].comments = [{ id: 'new-thread', ranges: [{ pos: 0, length: 7 }] }];
    p.fixture.replies[id][1]++;
    await workflow.apply(await workflow.preparePull(), () => true);
    let undo = await workflow.prepareUndo(record.id);
    assert.deepEqual(undo.files, []);
    assert.match(undo.stays.map(row => row.reason).join(' '), /comments or suggestions on Overleaf now/);
    p.fixture.replies[id][0] = { content: 'Results, edited.\n', comments: [], trackedChanges: [] }; p.fixture.replies[id][1]++;
    await writeFile(join(p.root, 'sections/results.tex'), 'Results, edited.\n');
    await workflow.apply(await workflow.preparePull(), () => true);
    undo = await workflow.prepareUndo(record.id);
    assert.match(undo.stays.map(row => row.reason).join(' '), /Edited on Overleaf since this Send/);
    // Back as sent, with a coauthor's file in the created folder: the file goes, the folder and that file stay.
    p.fixture.replies[id][0] = { content: 'Results.\nDrift: 0.64.\n', comments: [], trackedChanges: [] }; p.fixture.replies[id][1]++;
    await writeFile(join(p.root, 'sections/results.tex'), 'Results.\nDrift: 0.64.\n');
    p.fixture.addEntry('sections/figure.pdf', 'file');
    await workflow.apply(await workflow.preparePull(), () => true);
    undo = await workflow.prepareUndo(record.id);
    const result = await sync.push(undo.plan, () => true, () => {});
    assert.equal(p.created(), undefined);
    assert(p.folder('sections'));
    assert.deepEqual(p.folder('sections').fileRefs.map((file: any) => file.name), ['figure.pdf']);
    assert.deepEqual(result.mismatches, []);
  } finally { await p.close(); }
});
