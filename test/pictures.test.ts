import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseDocument } from 'htmlparser2';
import { Element, isTag, NodeWithChildren } from 'domhandler';
import { ProjectStore } from '../src/core/projectStore';
import { ReviewWorkflow, SyncService, remoteTexts } from '../src/core/folderWorkflow';
import { OverleafReader } from '../src/core/overleaf';
import { formatSize, gitBlobSha1, pictureSummary } from '../src/core/pictures';
import { projectContent, ProjectView } from '../src/extension/panel';
import { historyPage } from '../src/extension/history';
import { fixtureCookie, startFixtureServer } from './fixtureServer';

const base = ['main.tex', 'references.bib'], plot = 'figures/plot.png';
const bytes = (label: string, size = 0) => Buffer.concat([Buffer.from(`\x89PNG\r\n\x1a\n${label}`), Buffer.alloc(size, 7)]);

// A linked folder whose texts equal Overleaf. `pictures` are added on Overleaf before linking.
async function project(options: { pictures?: Record<string, Buffer>; linked?: string[]; maxUploadSize?: number } = {}) {
  const fixture = await startFixtureServer({ writable: true, maxUploadSize: options.maxUploadSize }), root = await mkdtemp(join(tmpdir(), 'overleaf-pictures-'));
  for (const [path, value] of Object.entries(options.pictures ?? {})) fixture.addEntry(path, 'file', value, { linked: options.linked?.includes(path) });
  const reader = new OverleafReader(fixture.baseUrl, fixtureCookie), inspection = await reader.inspect('test-project', base);
  for (const [path, text] of Object.entries(remoteTexts(inspection))) await writeFile(join(root, path), text);
  const open = (paths = base) => { const state = new ProjectStore(root, fixture.baseUrl, 'test-project', paths), sync = new SyncService(state, reader); return { state, sync, workflow: new ReviewWorkflow(sync) }; };
  const side = open();
  const local = (path: string) => readFile(join(root, path));
  const put = async (path: string, value: Buffer) => { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), value); };
  const pull = async () => { const plan = await side.workflow.preparePull(); return { plan, rows: (plan.pictures ?? []).map(p => [p.path, p.kind]) }; };
  return { fixture, root, reader, open, ...side, local, put, pull,
    close: async () => { await fixture.close(); await rm(root, { recursive: true, force: true }); } };
}

test('a picture new on Overleaf is listed with its size, downloaded by hash and written at Apply', async () => {
  const p = await project({ pictures: { [plot]: bytes('one', 2000) } });
  try {
    const { plan, rows } = await p.pull();
    assert.deepEqual(rows, [[plot, 'new']]);
    assert.equal(pictureSummary(plan.pictures![0]), `new on Overleaf · ${formatSize(bytes('one', 2000).length)}`);
    assert.equal(p.fixture.requestsFor(/\/blob\//).length, 1, 'downloaded by content hash');
    assert.equal(p.fixture.requestsFor(/\/file\//).length, 0);
    assert(plan.pictures![0].download && existsSync(plan.pictures![0].download));
    await p.workflow.apply(plan, () => true);
    assert.deepEqual(await p.local(plot), bytes('one', 2000));
    assert.equal((await p.state.pictures()).baseline[plot].hash, gitBlobSha1(bytes('one', 2000)));
    const [record] = await p.state.history();
    assert.deepEqual(record.pictures, [{ path: plot, kind: 'new', before: null, after: { hash: gitBlobSha1(bytes('one', 2000)), size: bytes('one', 2000).length } }]);
    // Synchronized: the next Get latest lists nothing and downloads nothing.
    const again = await p.pull();
    assert.deepEqual(again.rows, []);
    assert.equal(p.fixture.requestsFor(/\/blob\//).length, 1);
    // A text-only plan is not touched by pictures: the text baseline is unchanged.
    assert.equal(again.plan.files.length, 0);
  } finally { await p.close(); }
});

test('a picture changed on Overleaf replaces the local copy, which goes to Sync history as a .bin and is pruned with its record', async () => {
  const p = await project({ pictures: { [plot]: bytes('one') } });
  try {
    await p.workflow.apply((await p.pull()).plan, () => true);
    p.fixture.replaceFile(plot, bytes('two', 1500));
    const { plan, rows } = await p.pull();
    assert.deepEqual(rows, [[plot, 'changed']]);
    assert.equal(pictureSummary(plan.pictures![0]), `changed on Overleaf · ${formatSize(bytes('one').length)} → ${formatSize(bytes('two', 1500).length)}`);
    const before = (await p.state.historyUsage()).bytes;
    await p.workflow.apply(plan, () => true);
    assert.deepEqual(await p.local(plot), bytes('two', 1500));
    assert.deepEqual(await p.state.getBytes(gitBlobSha1(bytes('one'))), bytes('one'), 'the overwritten bytes are kept');
    assert((await p.state.historyUsage()).bytes >= before + bytes('one').length, 'counted in the history size');
    const [record] = await p.state.history();
    assert.deepEqual(record.pictures?.map(f => [f.kind, f.before?.hash, f.after?.hash]), [['changed', gitBlobSha1(bytes('one')), gitBlobSha1(bytes('two', 1500))]]);
    assert.match(historyPage([record]), /figures\/plot\.png/);
    // A third version: keeping only the newest record drops the first .bin.
    p.fixture.replaceFile(plot, bytes('three'));
    await p.workflow.apply((await p.pull()).plan, () => true);
    await p.state.pruneHistory(1, 0);
    assert.equal(await p.state.getBytes(gitBlobSha1(bytes('one'))), undefined);
    assert.deepEqual(await p.state.getBytes(gitBlobSha1(bytes('two', 1500))), bytes('two', 1500));
    // Downloads of earlier previews are cleared.
    assert.deepEqual(await readdir(await p.state.picturePath('downloads')), [`${gitBlobSha1(bytes('three'))}.png`]);
  } finally { await p.close(); }
});

test('a picture changed on both sides waits for a choice; equal bytes are no conflict', async () => {
  const p = await project({ pictures: { [plot]: bytes('one'), 'figures/b.jpg': bytes('b1'), 'figures/c.pdf': bytes('c1') } });
  try {
    await p.workflow.apply((await p.pull()).plan, () => true);
    for (const [path, label] of [[plot, 'two'], ['figures/b.jpg', 'b2'], ['figures/c.pdf', 'c2']]) p.fixture.replaceFile(path, bytes(label));
    await p.put(plot, bytes('mine')); await p.put('figures/b.jpg', bytes('mine-b')); await p.put('figures/c.pdf', bytes('c2'));
    const { plan, rows } = await p.pull();
    assert.deepEqual(rows, [['figures/b.jpg', 'both'], [plot, 'both']], 'c.pdf equals Overleaf: no row');
    await assert.rejects(p.workflow.apply(plan, () => true), /Resolve every file conflict/);
    const chosen = p.workflow.choosePicture(p.workflow.choosePicture((await p.pull()).plan, plot, 'remote'), 'figures/b.jpg', 'local');
    await p.workflow.apply(chosen, () => true);
    assert.deepEqual(await p.local(plot), bytes('two'), 'Use Overleaf version');
    assert.deepEqual(await p.state.getBytes(gitBlobSha1(bytes('mine'))), bytes('mine'), 'my copy stays in Sync history');
    assert.deepEqual(await p.local('figures/b.jpg'), bytes('mine-b'), 'Keep my version');
    const baseline = (await p.state.pictures()).baseline;
    assert.equal(baseline['figures/b.jpg'].hash, gitBlobSha1(bytes('b2')), 'the kept copy now differs from Overleaf: a local change for Send');
    assert.equal(baseline['figures/c.pdf'].hash, gitBlobSha1(bytes('c2')));
    assert.deepEqual((await p.pull()).rows, []);
  } finally { await p.close(); }
});

test('a picture never synchronized and different locally needs a choice too', async () => {
  const p = await project({ pictures: { [plot]: bytes('theirs') } });
  try {
    await p.put(plot, bytes('mine'));
    const { plan, rows } = await p.pull();
    assert.deepEqual(rows, [[plot, 'both']]);
    assert.match(plan.pictures![0].note!, /Not synchronized before/);
  } finally { await p.close(); }
});

test('a picture deleted on Overleaf keeps its local copy and leaves tracking', async () => {
  const p = await project({ pictures: { [plot]: bytes('one') } });
  try {
    await p.workflow.apply((await p.pull()).plan, () => true);
    p.fixture.removeFile(plot);
    const { plan, rows } = await p.pull();
    assert.deepEqual(rows, [[plot, 'deleted']]);
    assert.match(pictureSummary(plan.pictures![0]), /deleted on Overleaf, local copy kept/);
    await p.workflow.apply(plan, () => true);
    assert.deepEqual(await p.local(plot), bytes('one'));
    assert.equal((await p.state.pictures()).baseline[plot], undefined);
    assert.deepEqual((await p.pull()).rows, []);
  } finally { await p.close(); }
});

test('a missing local copy is restored from Overleaf', async () => {
  const p = await project({ pictures: { [plot]: bytes('one') } });
  try {
    await p.workflow.apply((await p.pull()).plan, () => true);
    await rm(join(p.root, plot));
    const { plan, rows } = await p.pull();
    assert.deepEqual(rows, [[plot, 'restore']]);
    await p.workflow.apply(plan, () => true);
    assert.deepEqual(await p.local(plot), bytes('one'));
  } finally { await p.close(); }
});

test('a linked file is downloaded read-only; a local change to it gets the reason as its note', async () => {
  const p = await project({ pictures: { [plot]: bytes('linked') }, linked: [plot] });
  try {
    await p.workflow.apply((await p.pull()).plan, () => true);
    assert.deepEqual(await p.local(plot), bytes('linked'));
    await p.put(plot, bytes('edited'));
    const { plan, rows } = await p.pull();
    assert.deepEqual(rows, [[plot, 'linked-local']]);
    assert.match(plan.pictures![0].note!, /Linked on Overleaf/);
    await p.workflow.apply(plan, () => true);
    assert.deepEqual(await p.local(plot), bytes('edited'), 'Get latest leaves the local change alone');
  } finally { await p.close(); }
});

test('a local picture over the upload limit is blocked with its size', async () => {
  const p = await project({ pictures: { [plot]: bytes('one') }, maxUploadSize: 100 });
  try {
    await p.put(plot, bytes('big', 500));
    const { plan, rows } = await p.pull();
    assert.equal(plan.inspection.maxUploadSize, 100, 'the limit comes from the project page');
    assert.deepEqual(rows, [[plot, 'blocked']]);
    assert.match(plan.pictures![0].note!, new RegExp(`${formatSize(bytes('big', 500).length)}, over Overleaf's 100 B upload limit`));
    await p.workflow.apply(plan, () => true);
    assert.deepEqual(await p.local(plot), bytes('big', 500));
    assert.equal((await p.state.pictures()).baseline[plot], undefined);
  } finally { await p.close(); }
});

test('downloaded bytes that do not hash to the tree\'s hash fail the read', async () => {
  const p = await project({ pictures: { [plot]: bytes('one') } });
  try {
    p.fixture.corruptDownloads(true);
    await assert.rejects(p.pull(), /do not match Overleaf's hash/);
    assert(!existsSync(join(p.root, plot)));
  } finally { await p.close(); }
});

test('the blob route falls back to the file route', async () => {
  const p = await project({ pictures: { [plot]: bytes('one') } });
  try {
    p.fixture.blobRouteMissing(true);
    const { plan, rows } = await p.pull();
    assert.deepEqual(rows, [[plot, 'new']]);
    assert.equal(p.fixture.requestsFor(/\/file\//).length, 1);
    await p.workflow.apply(plan, () => true);
    assert.deepEqual(await p.local(plot), bytes('one'));
  } finally { await p.close(); }
});

test('an interrupted picture Apply is recovered: a replaced copy comes back, a created one is removed', async () => {
  const p = await project({ pictures: { [plot]: bytes('one') } });
  try {
    await p.workflow.apply((await p.pull()).plan, () => true);
    p.fixture.replaceFile(plot, bytes('two')); p.fixture.addEntry('figures/new.jpg', 'file', bytes('new'));
    // valid() turns false once the new bytes are on disk, so Apply stops after writing them.
    const written = () => existsSync(join(p.root, 'figures/new.jpg')) && readFileSync(join(p.root, plot)).equals(bytes('two'));
    await assert.rejects(p.workflow.apply((await p.pull()).plan, () => !written()), /Recover Local Apply/);
    assert((await p.state.read()).localApply?.pictures);
    await p.workflow.recover(() => true);
    assert.deepEqual(await p.local(plot), bytes('one'));
    assert(!existsSync(join(p.root, 'figures/new.jpg')));
    assert.equal((await p.state.pictures()).baseline[plot].hash, gitBlobSha1(bytes('one')), 'the old baseline stays');
    assert.deepEqual((await p.pull()).rows.sort(), [['figures/new.jpg', 'new'], [plot, 'changed']]);
  } finally { await p.close(); }
});

test('a local picture changed during review fails Apply as stale', async () => {
  const p = await project({ pictures: { [plot]: bytes('one') } });
  try {
    const { plan } = await p.pull();
    await p.put(plot, bytes('late'));
    await assert.rejects(p.workflow.apply(plan, () => true), /local contents changed/);
    assert.deepEqual(await p.local(plot), bytes('late'));
  } finally { await p.close(); }
});

test('with syncPictures off, Get latest neither lists nor downloads pictures', async () => {
  const p = await project({ pictures: { [plot]: bytes('one') } });
  try {
    p.state.syncPictures = () => false;
    const { plan, rows } = await p.pull();
    assert.deepEqual(rows, []);
    assert.equal(p.fixture.requestsFor(/\/blob\//).length, 0);
    await p.workflow.apply(plan, () => true);
    assert(!existsSync(join(p.root, plot)));
  } finally { await p.close(); }
});

test('a selected text name that Overleaf stores as a file stays blocked with that reason', async () => {
  const p = await project();
  try {
    p.fixture.addEntry('data.tex', 'file', Buffer.from([0xff, 0xfe, 0x00]));
    await writeFile(join(p.root, 'data.tex'), 'text');
    const { workflow } = p.open([...base, 'data.tex']);
    await assert.rejects(workflow.preparePull(), /Overleaf stores it as a file \(as it does for text over 1 MB or not in UTF-8\)/);
  } finally { await p.close(); }
});

const view = (extra: Partial<ProjectView> = {}): ProjectView => ({ name: 'Sample project', files: ['main.tex'], state: 'Ready.', writes: true, connected: true, linked: true, rows: [], reviews: {}, ...extra });
function elements(html: string): Element[] {
  const result: Element[] = [];
  const walk = (node: NodeWithChildren) => { for (const child of node.children) { if (isTag(child)) result.push(child); if ('children' in child) walk(child as NodeWithChildren); } };
  walk(parseDocument(html)); return result;
}
const text = (node: any): string => node.data ?? (node.children ?? []).map(text).join('');

test('picture rows share the file list, open the comparison and offer the two versions when changed on both sides', () => {
  const html = projectContent(view({ preview: { id: 'p', files: [{ path: 'main.tex', added: 1, removed: 0 }], comments: [], selectedPath: `picture:${plot}`,
    pictures: [{ path: plot, summary: 'changed on Overleaf · 120 KB → 134 KB' }, { path: 'figures/b.jpg', summary: 'changed on both sides · 2 KB → 3 KB', conflict: true, choose: true, note: 'Changed here and on Overleaf. Choose a version.' }] } }));
  const nodes = elements(html), rows = nodes.filter(n => n.attribs['data-command'] === 'openPreviewDiff' && n.attribs['data-path']);
  assert.deepEqual(rows.map(n => [n.attribs['data-path'], n.attribs['data-value']]), [['main.tex', undefined], [plot, 'picture'], ['figures/b.jpg', 'picture']]);
  assert.match(text(rows[1]), /figures\/plot\.png.*changed on Overleaf · 120 KB → 134 KB/);
  assert.equal(rows[1].attribs['aria-pressed'], 'true');
  assert.match(text(nodes.find(n => n.name === 'h3' && /^Files/.test(text(n)))!), /Files \(3\)/);
  const choices = nodes.filter(n => ['useRemoteVersion', 'keepLocalVersion'].includes(n.attribs['data-command']));
  assert.deepEqual(choices.map(n => [n.attribs['data-command'], n.attribs['data-path'], n.attribs['data-value']]), [['useRemoteVersion', 'figures/b.jpg', 'picture'], ['keepLocalVersion', 'figures/b.jpg', 'picture']]);
  assert.match(html, /Changed here and on Overleaf/);
  assert.doesNotMatch(html, /No file text changes/);
  // A picture conflict holds Apply like a text conflict.
  const status = nodes.find(n => /(^| )status( |$)/.test(n.attribs.class ?? ''))!;
  assert.equal(status.attribs.class, 'status status-warning');
});
