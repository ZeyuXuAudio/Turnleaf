import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectStore, isSentPicture } from '../src/core/projectStore';
import { ReviewWorkflow, SyncService, remoteTexts, pushReport, planDifferences } from '../src/core/folderWorkflow';
import { OverleafReader } from '../src/core/overleaf';
import { formatSize, gitBlobSha1, localPicture, outgoingSummary } from '../src/core/pictures';
import { projectContent, ProjectView } from '../src/extension/panel';
import { parseDocument } from 'htmlparser2';
import { Element, isTag, NodeWithChildren } from 'domhandler';
import { fixtureCookie, startFixtureServer } from './fixtureServer';

// Step nontext-files-send: pictures go out at Send and come back with Undo this send.
const base = ['main.tex', 'references.bib'], plot = 'figures/plot.png';
const bytes = (label: string, size = 0) => Buffer.concat([Buffer.from(`\x89PNG\r\n\x1a\n${label}`), Buffer.alloc(size, 7)]);

// A linked folder whose texts and pictures equal Overleaf after one Get latest.
async function project(options: { pictures?: Record<string, Buffer>; linked?: string[]; maxUploadSize?: number } = {}) {
  const fixture = await startFixtureServer({ writable: true, maxUploadSize: options.maxUploadSize }), root = await mkdtemp(join(tmpdir(), 'overleaf-pictures-send-'));
  for (const [path, value] of Object.entries(options.pictures ?? {})) fixture.addEntry(path, 'file', value, { linked: options.linked?.includes(path) });
  const reader = new OverleafReader(fixture.baseUrl, fixtureCookie), inspection = await reader.inspect('test-project', base);
  for (const [path, text] of Object.entries(remoteTexts(inspection))) await writeFile(join(root, path), text);
  const state = new ProjectStore(root, fixture.baseUrl, 'test-project', base), sync = new SyncService(state, reader), workflow = new ReviewWorkflow(sync);
  await workflow.apply(await workflow.preparePull(), () => true);
  const put = async (path: string, value: Buffer) => { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), value); };
  const add = async (...paths: string[]) => { const now = await state.pictures(); await state.setPictures({ ...now, added: [...now.added ?? [], ...paths] }); };
  const rows = async () => { const plan = await workflow.prepareSend(); return { plan, rows: (plan.pictures ?? []).map(p => [p.path, p.kind]) }; };
  const uploads = () => fixture.requestsFor(/\/upload$/).length;
  return { fixture, root, reader, state, sync, workflow, put, add, rows, uploads,
    close: async () => { await fixture.close(); await rm(root, { recursive: true, force: true }); } };
}
const send = (p: Awaited<ReturnType<typeof project>>, plan: Parameters<SyncService['push']>[0]) => p.sync.push(plan, () => true, () => {});

test('a picture changed locally replaces Overleaf\'s copy: the replaced bytes are kept, the upload is read back and recorded', async () => {
  const p = await project({ pictures: { [plot]: bytes('one', 1000) } });
  try {
    const old = p.fixture.findFile(plot)._id;
    await p.put(plot, bytes('two', 3000));
    const { plan, rows } = await p.rows();
    assert.deepEqual(rows, [[plot, 'replace']]);
    assert.equal(outgoingSummary(plan.pictures![0]), `replaces Overleaf file · ${formatSize(bytes('one', 1000).length)} → ${formatSize(bytes('two', 3000).length)}`);
    assert.match(pushReport(plan), /figures\/plot\.png: replaces Overleaf file/);
    await send(p, plan);
    const now = p.fixture.findFile(plot);
    assert.equal(now.hash, gitBlobSha1(bytes('two', 3000)));
    assert.notEqual(now._id, old, 'Overleaf gives the upload a new file ID');
    assert.equal(p.uploads(), 1);
    const [record] = await p.state.history();
    assert.equal(record.outcome, 'success');
    assert.deepEqual(record.completed, [`picture:${plot}`]);
    assert.deepEqual(record.sent!.files[plot], { replacedHash: gitBlobSha1(bytes('one', 1000)), sentHash: gitBlobSha1(bytes('two', 3000)), fileId: now._id });
    assert.deepEqual(record.pictures, [{ path: plot, kind: 'send-replace', before: { hash: gitBlobSha1(bytes('one', 1000)), size: bytes('one', 1000).length }, after: { hash: gitBlobSha1(bytes('two', 3000)), size: bytes('two', 3000).length } }]);
    assert.deepEqual(await p.state.getBytes(gitBlobSha1(bytes('one', 1000))), bytes('one', 1000), 'the replaced bytes are in Sync history');
    assert.deepEqual((await p.state.pictures()).baseline[plot], { hash: gitBlobSha1(bytes('two', 3000)), size: bytes('two', 3000).length });
    // In sync both ways afterwards.
    assert.deepEqual((await p.rows()).rows, []);
    assert.deepEqual(((await p.workflow.preparePull()).pictures ?? []).map(r => r.path), []);
  } finally { await p.close(); }
});

test('a local-only picture goes out only once added in Choose files, and its folder is created first', async () => {
  const p = await project(), path = 'figures/new/plot.png';
  try {
    await p.put(path, bytes('new', 500));
    assert.deepEqual((await p.rows()).rows, [], 'not added: not sent');
    await p.add(path);
    const { plan, rows } = await p.rows();
    assert.deepEqual(rows, [[path, 'create']]);
    assert.deepEqual(plan.pictures![0].folders, ['figures', 'figures/new']);
    assert.equal(outgoingSummary(plan.pictures![0]), `new on Overleaf · ${formatSize(bytes('new', 500).length)} · creates folder figures/, figures/new/`);
    await send(p, plan);
    const file = p.fixture.findFile(path);
    assert.equal(file.hash, gitBlobSha1(bytes('new', 500)));
    const [record] = await p.state.history();
    assert.deepEqual(record.completed, ['folder:figures', 'folder:figures/new', `picture:${path}`]);
    assert.equal(record.sent!.created![path].fileId, file._id);
    assert.deepEqual(record.sent!.created![path].folders.map(f => f.path), ['figures', 'figures/new']);
    const state = await p.state.pictures();
    assert.equal(state.baseline[path].hash, gitBlobSha1(bytes('new', 500)));
    assert.deepEqual(state.added, [], 'no longer only local');
    assert.deepEqual((await p.rows()).rows, []);
  } finally { await p.close(); }
});

test('pictures that cannot go out are listed with the reason and leave the rest of the Send', async () => {
  const p = await project({ pictures: { 'big.png': bytes('big'), 'linked.png': bytes('link') }, linked: ['linked.png'], maxUploadSize: 2000 });
  try {
    await p.put('big.png', bytes('bigger', 3000));
    await p.put('linked.png', bytes('changed'));
    p.fixture.addEntry('clash.png', 'doc', 'a text document');
    await p.put('clash.png', bytes('clash'));
    await p.add('clash.png');
    await writeFile(join(p.root, 'main.tex'), (await readFile(join(p.root, 'main.tex'), 'utf8')) + '\n% more\n');
    const { plan, rows } = await p.rows();
    assert.deepEqual(rows, [['big.png', 'blocked'], ['clash.png', 'blocked'], ['linked.png', 'blocked']]);
    const notes = Object.fromEntries(plan.pictures!.map(r => [r.path, r.note]));
    assert.match(notes['big.png']!, new RegExp(`${formatSize(bytes('bigger', 3000).length)}, over Overleaf's ${formatSize(2000)} upload limit`));
    assert.match(notes['clash.png']!, /text document of this name.*lose its comments/);
    assert.match(notes['linked.png']!, /linked/i);
    assert.equal(outgoingSummary(plan.pictures![0]), `not sent · ${formatSize(bytes('bigger', 3000).length)}`);
    await send(p, plan);
    assert.equal(p.uploads(), 0, 'no picture went out');
    assert.deepEqual((await p.state.history())[0].completed, ['file:main.tex']);
  } finally { await p.close(); }
});

test('Send stops as stale when the picture became a text document or a linked file since the summary', async () => {
  for (const change of ['doc', 'linked'] as const) {
    const p = await project({ pictures: { [plot]: bytes('one') } });
    try {
      await p.put(plot, bytes('two'));
      const { plan } = await p.rows();
      if (change === 'doc') { p.fixture.removeFile(plot); p.fixture.addEntry(plot, 'doc', 'now text'); }
      else p.fixture.findFile(plot).linkedFileData = { provider: 'url', url: 'https://example.org/figure.png' };
      await assert.rejects(send(p, plan), (error: any) => error.code === 'stale' && (change === 'doc' ? /text document/.test(error.message) : /linked file/.test(error.message)));
      assert.equal(p.uploads(), 0, `${change}: nothing uploaded`);
      assert.equal((await p.state.history())[0].outcome, 'stale');
      // The summary shown differs from a fresh one: the row would not be sent.
      const fresh = await p.workflow.prepareSend();
      assert(planDifferences(plan, fresh).includes(`picture:${plot}`));
    } finally { await p.close(); }
  }
});

test('an unclear answer to an upload stays uncertain and is not retried; a refusal writes nothing', async () => {
  const p = await project({ pictures: { [plot]: bytes('one') } });
  try {
    await p.put(plot, bytes('two'));
    p.fixture.failPicture('plot.png', 'unclear');
    await assert.rejects(send(p, (await p.rows()).plan), /unclear answer/);
    assert.equal(p.uploads(), 1, 'sent once');
    const [record] = await p.state.history();
    assert.equal(record.outcome, 'uncertain');
    assert.deepEqual((await p.state.read()).partialSend?.uncertain, [`picture:${plot}`]);
    assert.equal((await p.state.pictures()).baseline[plot].hash, gitBlobSha1(bytes('one')), 'the baseline waits for Get latest');
  } finally { await p.close(); }
  const q = await project({ pictures: { [plot]: bytes('one') } });
  try {
    await q.put(plot, bytes('two'));
    q.fixture.failPicture('plot.png', 'refuse');
    await assert.rejects(send(q, (await q.rows()).plan), /refused the upload.*Nothing was written/);
    assert.equal((await q.state.read()).partialSend, undefined);
    assert.equal(q.fixture.findFile(plot).hash, gitBlobSha1(bytes('one')));
  } finally { await q.close(); }
});

test('Undo this send uploads the replaced bytes back and deletes the created picture, each only while as sent', async () => {
  const p = await project({ pictures: { [plot]: bytes('one', 800) } }), made = 'new.png';
  try {
    await p.put(plot, bytes('two', 900)); await p.put(made, bytes('made')); await p.add(made);
    await send(p, (await p.rows()).plan);
    const [record] = await p.state.history();
    assert(isSentPicture(record.sent!.files[plot]) && isSentPicture(record.sent!.files[made]));
    const undo = await p.workflow.prepareUndo(record.id);
    assert.deepEqual(undo.plan.pictures!.map(r => [r.path, r.kind]), [[plot, 'restore'], [made, 'delete']]);
    assert.equal(outgoingSummary(undo.plan.pictures!.find(r => r.kind === 'restore')!), `puts back the file this Send replaced · ${formatSize(bytes('two', 900).length)} → ${formatSize(bytes('one', 800).length)}`);
    const downloads = p.fixture.requestsFor(/\/blob\//).length;
    await send(p, undo.plan);
    assert.equal(p.fixture.findFile(plot).hash, gitBlobSha1(bytes('one', 800)));
    assert.equal(p.fixture.findFile(made), undefined);
    assert.equal(p.fixture.requestsFor(/\/blob\//).length, downloads, 'restored from Sync history, not downloaded');
    const state = await p.state.pictures();
    assert.equal(state.baseline[plot].hash, gitBlobSha1(bytes('one', 800)));
    assert.equal(state.baseline[made], undefined);
    assert.deepEqual(state.added, [made], 'the local copy is only local again');
    assert.equal((await p.state.history(record.id))[0].undoneBy, (await p.state.history())[0].id);
    // The local files stay as sent: Send lists them again.
    assert.deepEqual((await p.rows()).rows, [[plot, 'replace'], [made, 'create']]);
  } finally { await p.close(); }
});

test('Undo this send leaves a picture changed on Overleaf since, and falls back to Overleaf\'s copy by hash once the kept bytes are pruned', async () => {
  const p = await project({ pictures: { [plot]: bytes('one'), 'other.png': bytes('o1') } });
  try {
    await p.put(plot, bytes('two')); await p.put('other.png', bytes('o2'));
    await send(p, (await p.rows()).plan);
    const [record] = await p.state.history();
    p.fixture.replaceFile('other.png', bytes('o3'));
    await p.workflow.apply(await p.workflow.preparePull(), () => true);
    // The kept copy of plot.png is gone from Sync history.
    const find = async (dir: string): Promise<string[]> => (await Promise.all((await readdir(dir, { withFileTypes: true })).map(entry => entry.isDirectory() ? find(join(dir, entry.name)) : [join(dir, entry.name)]))).flat();
    for (const file of await find(join(p.root, '.turnleaf'))) if (file.endsWith(`${gitBlobSha1(bytes('one'))}.bin`)) await rm(file);
    const undo = await p.workflow.prepareUndo(record.id);
    assert.deepEqual(undo.plan.pictures!.map(r => [r.path, r.kind]), [[plot, 'restore']]);
    assert.match(undo.plan.pictures![0].note!, /no longer in Sync history/);
    assert.deepEqual(undo.stays.map(row => [row.key, row.reason]), [['picture:other.png', 'Replaced or changed on Overleaf since this Send.']]);
    const before = p.fixture.requestsFor(/\/blob\//).length;
    await send(p, undo.plan);
    assert.equal(p.fixture.requestsFor(/\/blob\//).length, before + 1, 'downloaded by hash');
    assert.equal(p.fixture.findFile(plot).hash, gitBlobSha1(bytes('one')));
    assert.equal(p.fixture.findFile('other.png').hash, gitBlobSha1(bytes('o3')));
  } finally { await p.close(); }
});

test('a tree event for the picture in the last moment stops the upload', async () => {
  const p = await project({ pictures: { [plot]: bytes('one') } });
  try {
    await p.put(plot, bytes('two'));
    const { plan } = await p.rows();
    // A coauthor renames another entry to this name while Send reads the tree: the event arrives before the request.
    const original = p.reader.projectTree.bind(p.reader);
    let reads = 0;
    p.reader.projectTree = async (id: string) => { const tree = await original(id); if (++reads === 1) { p.fixture.emit('reciveEntityRename', ['f00000000000000000000099', 'plot.png']); await new Promise(resolve => setTimeout(resolve, 600)); } return tree; };
    await assert.rejects(send(p, plan), /changed on Overleaf just now/);
    assert.equal(p.uploads(), 0);
  } finally { await p.close(); }
});

test('a rename of the picture\'s folder in the last moment stops the upload', async () => {
  const p = await project({ pictures: { [plot]: bytes('one') } });
  try {
    await p.put(plot, bytes('two'));
    const { plan } = await p.rows();
    const figures = p.fixture.tree.folders.find((folder: any) => folder.name === 'figures')._id;
    // The event names the folder ID and its new name, not the picture.
    const original = p.reader.projectTree.bind(p.reader);
    let reads = 0;
    p.reader.projectTree = async (id: string) => { const tree = await original(id); if (++reads === 1) { p.fixture.emit('reciveEntityRename', [figures, 'archive']); await new Promise(resolve => setTimeout(resolve, 600)); } return tree; };
    await assert.rejects(send(p, plan), /changed on Overleaf just now/);
    assert.equal(p.uploads(), 0);
  } finally { await p.close(); }
});

test('an entry moved into the target folder in the last moment stops a new picture', async () => {
  const p = await project({ pictures: { 'figures/other.png': bytes('o') } });
  try {
    await p.put(plot, bytes('new')); await p.add(plot);
    const { plan, rows } = await p.rows();
    assert.deepEqual(rows, [[plot, 'create']]);
    const figures = p.fixture.tree.folders.find((folder: any) => folder.name === 'figures')._id;
    // A move event carries only the entity and the target folder, not the moved entry's name.
    const original = p.reader.projectTree.bind(p.reader);
    let reads = 0;
    p.reader.projectTree = async (id: string) => { const tree = await original(id); if (++reads === 1) { p.fixture.emit('reciveEntityMove', ['f00000000000000000000098', figures]); await new Promise(resolve => setTimeout(resolve, 600)); } return tree; };
    await assert.rejects(send(p, plan), /changed on Overleaf just now/);
    assert.equal(p.uploads(), 0);
  } finally { await p.close(); }
});

test('a picture name with a backslash on Overleaf is not tracked, and local picture paths with one are refused', async () => {
  const p = await project({ pictures: { 'evil\\plot.png': bytes('x'), [plot]: bytes('one') } });
  try {
    assert.deepEqual(Object.keys((await p.state.pictures()).baseline), [plot]);
    assert.deepEqual(await readdir(p.root).then(names => names.filter(name => name.includes('\\'))), []);
    assert.deepEqual((await p.rows()).rows, []);
    await assert.rejects(localPicture(p.root, 'evil\\plot.png'), /not a supported picture path/);
    await assert.rejects(localPicture(p.root, 'figures/../plot.png'), /not a supported picture path/);
  } finally { await p.close(); }
});

test('a read refused by Overleaf\'s per-minute limit on opening the project waits and opens again; Send reads the tree twice per picture', async () => {
  const p = await project({ pictures: { [plot]: bytes('one') } });
  try {
    p.reader.rateLimitWaitMs = 5;
    await p.put(plot, bytes('two'));
    const { plan } = await p.rows();
    const opens = () => p.fixture.requestsFor(/^\/socket\.io\/1\/$/).length, before = opens();
    p.fixture.rejectJoins(2);
    await send(p, plan);
    assert.equal(p.fixture.findFile(plot).hash, gitBlobSha1(bytes('two')));
    // The Send's connection (refused twice, then opened), the tree before the upload, the read-back and the final tree.
    assert.equal(opens() - before, 2 + 4);
    p.fixture.rejectJoins(10);
    await assert.rejects(p.reader.projectTree('test-project'), /45 times a minute/);
  } finally { await p.close(); }
});

const view = (extra: Partial<ProjectView> = {}): ProjectView => ({ name: 'Sample project', files: ['main.tex'], state: 'Ready.', writes: true, connected: true, linked: true, rows: [], reviews: {}, ...extra });
function elements(html: string): Element[] {
  const result: Element[] = [];
  const walk = (node: NodeWithChildren) => { for (const child of node.children) { if (isTag(child)) result.push(child); if ('children' in child) walk(child as NodeWithChildren); } };
  walk(parseDocument(html)); return result;
}
const text = (node: any): string => node.data ?? (node.children ?? []).map(text).join('');

test('picture rows join the outgoing summary with sizes, open the comparison, count in the totals and note Track Changes', () => {
  const html = projectContent(view({ outgoing: { files: [{ path: 'main.tex', added: 3, removed: 1 }], comments: [], trackChanges: true, selectedPath: `picture:${plot}`,
    pictures: [{ path: plot, summary: 'replaces Overleaf file · 120 KB → 134 KB', sends: true }, { path: 'figures/new.png', summary: 'new on Overleaf · 134 KB · creates folder figures/', sends: true, created: true }, { path: 'big.pdf', summary: 'not sent · 60 MB', sends: false, note: '60 MB, over Overleaf\'s 50 MB upload limit. It is not sent.' }] } }));
  const nodes = elements(html), rows = nodes.filter(n => n.attribs['data-command'] === 'openOutgoingDiff');
  assert.deepEqual(rows.map(n => [n.attribs['data-path'], n.attribs['data-value']]), [['main.tex', ''], [plot, 'picture'], ['figures/new.png', 'picture'], ['big.pdf', 'picture']]);
  assert.equal(rows[1].attribs['aria-pressed'], 'true');
  assert.match(text(rows[2]), /new on Overleaf · 134 KB · creates folder figures\//);
  const head = text(nodes.find(n => n.name === 'span' && n.attribs.class === 'group-head')!);
  assert.match(head, /Going out · 1 file \+3−1 · 2 pictures/);
  assert.equal((html.match(/Replaces the file for everyone, not a suggestion\./g) ?? []).length, 1);
  assert.equal((html.match(/New for everyone, not a suggestion\./g) ?? []).length, 1);
  assert.match(html, /over Overleaf&#39;s 50 MB upload limit/);
  assert(nodes.some(n => n.attribs['data-command'] === 'send' && !('disabled' in n.attribs)));
  // Only blocked pictures: nothing to send.
  const none = elements(projectContent(view({ outgoing: { files: [], comments: [], pictures: [{ path: 'big.pdf', summary: 'not sent · 60 MB', sends: false, note: 'over the limit' }] } })));
  assert(!none.some(n => n.attribs['data-command'] === 'send'));
  // The held picture keeps its row and reason.
  assert.deepEqual(none.filter(n => n.attribs['data-command'] === 'openOutgoingDiff').map(n => n.attribs['data-path']), ['big.pdf']);
  assert(none.some(n => n.attribs.class === 'row-reason' && text(n) === 'over the limit'));
});

test('the undo summary lists the pictures it puts back or deletes and enables Send undo for them', () => {
  const html = projectContent(view({ undo: { record: 'r1', time: '2026-11-14T10:00:00Z', files: [], comments: [], stays: [],
    pictures: [{ path: plot, summary: 'puts back the file this Send replaced · 134 KB → 120 KB', sends: true }, { path: 'new.png', summary: 'deleted from Overleaf · 2 KB', sends: true }] } }));
  const nodes = elements(html), rows = nodes.filter(n => n.attribs['data-command'] === 'openOutgoingDiff');
  assert.deepEqual(rows.map(n => [n.attribs['data-path'], n.attribs['data-value']]), [[plot, 'undo-picture'], ['new.png', 'undo-picture']]);
  assert.match(text(nodes.find(n => n.name === 'span' && n.attribs.class === 'group-head')!), /Taken back from Overleaf · 2 pictures/);
  const button = nodes.find(n => n.attribs['data-command'] === 'sendUndo')!;
  assert(!('disabled' in button.attribs));
});
