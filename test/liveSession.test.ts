import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OverleafReader, RemoteSession } from '../src/core/overleaf';
import { ProjectStore } from '../src/core/projectStore';
import { ReviewWorkflow, SyncService, remoteTexts } from '../src/core/folderWorkflow';
import { classifyLiveEvent } from '../src/core/live';
import { withOperation } from '../src/core/operation';
import { fixtureCookie, startFixtureServer } from './fixtureServer';

const paths = ['main.tex', 'references.bib'];
type Fixture = Awaited<ReturnType<typeof startFixtureServer>>;
const handshakes = (fixture: Fixture) => fixture.requests.filter(r => r.path === '/socket.io/1/').length;
const joins = (fixture: Fixture, doc: string) => fixture.requests.filter(r => r.packet?.includes('"joinDoc"') && r.packet.includes(`"${doc}"`)).length;
// A collaborator's edit, as Overleaf broadcasts it to every joined client.
function collaboratorEdit(fixture: Fixture, text: string) {
  const version = fixture.replies.modern[1];
  fixture.replies.modern[0] = { content: text, comments: [], trackedChanges: [] }; fixture.replies.modern[1]++;
  const event = '5:::' + JSON.stringify({ name: 'otUpdateApplied', args: [{ doc: 'modern', v: version, op: [], meta: { user_id: 'reviewer' } }] });
  for (const queue of fixture.sockets.values()) queue.push(event);
}
const until = async (condition: () => boolean) => { for (let i = 0; i < 200 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 10)); assert(condition()); };

test('realtime events are sorted into ignored, re-read and reconnect', () => {
  assert.equal(classifyLiveEvent('clientTracking.clientUpdated'), 'ignore');
  assert.equal(classifyLiveEvent('otUpdateApplied'), 'update');
  assert.equal(classifyLiveEvent('new-comment'), 'update', 'Unknown names re-read the comment list');
  assert.equal(classifyLiveEvent('reciveNewDoc'), 'reconnect');
  assert.equal(classifyLiveEvent('toggle-track-changes'), 'reconnect');
});

test('a live session re-reads only documents that changed, over one connection', async () => {
  const fixture = await startFixtureServer();
  let session: RemoteSession | undefined;
  try {
    const reader = new OverleafReader(fixture.baseUrl, fixtureCookie);
    session = await reader.openSession('test-project', paths, { live: true });
    const legacyJoins = joins(fixture, 'legacy');
    collaboratorEdit(fixture, 'A collaborator rewrote this.\n');
    await until(() => session!.socket.updates.length > 0);
    const updated = await session.refresh({ docs: 'changed' });
    assert.equal(updated.docs.find(doc => doc.path === 'main.tex')!.text, 'A collaborator rewrote this.\n');
    assert.equal(joins(fixture, 'legacy'), legacyJoins, 'The unchanged file is not re-read');
    const modernJoins = joins(fixture, 'modern');
    await session.refresh({ docs: 'changed' });
    assert.equal(joins(fixture, 'modern'), modernJoins, 'No new event: no document read, only the comment list');
    assert.equal(handshakes(fixture), 1);
  } finally { await session?.close(); await fixture.close(); }
});

test('cancelling the operation that opened a live session does not drop it', async () => {
  const fixture = await startFixtureServer();
  let session: RemoteSession | undefined;
  try {
    const reader = new OverleafReader(fixture.baseUrl, fixtureCookie), abort = new AbortController();
    session = await withOperation({ signal: abort.signal, report() {} }, () => reader.openSession('test-project', paths, { live: true }));
    abort.abort();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert(session.socket.alive);
    assert.equal((await session.refresh()).docs.length, 2);
  } finally { await session?.close(); await fixture.close(); }
});

test('a server disconnect is reported once and the session stops', async () => {
  const fixture = await startFixtureServer();
  try {
    const session = await new OverleafReader(fixture.baseUrl, fixtureCookie).openSession('test-project', paths, { live: true });
    const lost: Error[] = [];
    session.socket.onClose(error => lost.push(error));
    for (const queue of fixture.sockets.values()) queue.push('0::');
    await until(() => lost.length > 0);
    assert(!session.socket.alive); assert.equal(lost.length, 1);
    await session.close();
  } finally { await fixture.close(); }
});

test('Send through a live session reuses its connection and leaves it open', async () => {
  const fixture = await startFixtureServer({ writable: true }), root = await mkdtemp(join(tmpdir(), 'overleaf-live-'));
  let session: RemoteSession | undefined;
  try {
    fixture.replies.modern[0] = { content: 'Rain was excluded.\n', comments: [], trackedChanges: [] };
    const reader = new OverleafReader(fixture.baseUrl, fixtureCookie);
    for (const [path, text] of Object.entries(remoteTexts(await reader.inspect('test-project', paths)))) await writeFile(join(root, path), text);
    const sync = new SyncService(new ProjectStore(root, fixture.baseUrl, 'test-project', paths), reader, async () => session ??= await reader.openSession('test-project', paths, { live: true }));
    const workflow = new ReviewWorkflow(sync);
    await workflow.apply(await workflow.preparePull(), () => true);
    const before = handshakes(fixture);
    await writeFile(join(root, 'main.tex'), 'Rain was excluded by the gauge.\n');
    const result = await sync.push(await workflow.prepareSend(), () => true, () => {});
    assert.equal(result.inspection.docs[0].text, 'Rain was excluded by the gauge.\n');
    assert.equal(handshakes(fixture), before, 'Review and Send opened no further connection');
    assert(session!.socket.alive, 'The live session stays open after Send');
  } finally { await session?.close(); await fixture.close(); await rm(root, { recursive: true, force: true }); }
});

// Fast send: the live connection's edit reports stand in for the full reads around the writes.
async function sendSetup(check: 'full' | 'fast', liveConnection = true) {
  const fixture = await startFixtureServer({ writable: true }), root = await mkdtemp(join(tmpdir(), 'overleaf-check-'));
  let session: RemoteSession | undefined;
  fixture.replies.modern[0] = { content: 'Rain was excluded.\n', comments: [], trackedChanges: [] };
  const reader = new OverleafReader(fixture.baseUrl, fixtureCookie);
  for (const [path, text] of Object.entries(remoteTexts(await reader.inspect('test-project', paths)))) await writeFile(join(root, path), text);
  const sync = new SyncService(new ProjectStore(root, fixture.baseUrl, 'test-project', paths), reader, async () => liveConnection ? session ??= await reader.openSession('test-project', paths, { live: true }) : undefined);
  sync.sendCheck = () => check;
  const workflow = new ReviewWorkflow(sync);
  await workflow.apply(await workflow.preparePull(), () => true);
  await writeFile(join(root, 'main.tex'), 'Rain was excluded by the gauge.\n');
  const plan = await workflow.prepareSend();
  return { fixture, sync, plan, close: async () => { await session?.close(); await fixture.close(); await rm(root, { recursive: true, force: true }); } };
}
// An edit Overleaf applies without reporting it to this connection.
const unreported = (fixture: Fixture, doc: 'modern' | 'legacy') => {
  if (doc === 'modern') fixture.replies.modern[0] = { content: 'Changed without a report.\n', comments: [], trackedChanges: [] };
  else fixture.replies.legacy[0] = ['Changed without a report.', ''];
  fixture.replies[doc][1]++;
};

test('fast send re-reads only the written file; full send re-reads every file', async () => {
  for (const check of ['fast', 'full'] as const) {
    const r = await sendSetup(check);
    try {
      const before = joins(r.fixture, 'legacy');
      const result = await r.sync.push(r.plan, () => true, () => {});
      assert.equal(result.inspection.docs.find(doc => doc.path === 'main.tex')!.text, 'Rain was excluded by the gauge.\n');
      if (check === 'fast') assert.equal(joins(r.fixture, 'legacy'), before, 'Fast: the unedited, unwritten file is not re-read');
      else assert.equal(joins(r.fixture, 'legacy') - before, 3, 'Full: the unwritten file is read before, after the file writes, and at the end');
      assert.deepEqual((await r.sync.state.history(result.history))[0].check, { mode: check });
    } finally { await r.close(); }
  }
});

test('fast send re-reads a file Overleaf reported as edited, and stops', async () => {
  const r = await sendSetup('fast');
  try {
    const legacyJoins = joins(r.fixture, 'legacy');
    r.fixture.replies.legacy[0] = ['A collaborator edited this.', '']; const version = r.fixture.replies.legacy[1]++;
    const event = '5:::' + JSON.stringify({ name: 'otUpdateApplied', args: [{ doc: 'legacy', v: version, op: [], meta: { user_id: 'reviewer' } }] });
    for (const queue of r.fixture.sockets.values()) queue.push(event);
    const live = await r.sync.liveSession(); await until(() => live!.socket.updates.length > 0);
    await assert.rejects(r.sync.push(r.plan, () => true, () => {}), /Overleaf changed during review/);
    assert(joins(r.fixture, 'legacy') > legacyJoins, 'The reported file was re-read');
  } finally { await r.close(); }
});

test('fast send without a live connection reads in full and records why', async () => {
  const r = await sendSetup('fast', false);
  try {
    const result = await r.sync.push(r.plan, () => true, () => {});
    assert.deepEqual((await r.sync.state.history(result.history))[0].check, { mode: 'full', note: 'no live connection' });
  } finally { await r.close(); }
});

test('the risk of fast send: an unreported edit goes unseen unless Send writes that file', async () => {
  // In a file this Send does not write: full stops before writing, fast sends.
  for (const check of ['full', 'fast'] as const) {
    const r = await sendSetup(check);
    try {
      await r.sync.liveSession(); unreported(r.fixture, 'legacy');
      if (check === 'full') await assert.rejects(r.sync.push(r.plan, () => true, () => {}), /Overleaf changed during review/);
      else assert.equal((await r.sync.push(r.plan, () => true, () => {})).inspection.docs.find(doc => doc.path === 'references.bib')!.text, 'Jörg cite.\n', 'Fast keeps its earlier view of the unwritten file');
    } finally { await r.close(); }
  }
  // In a file this Send writes: the read just before its write catches it, in both checks.
  const r = await sendSetup('fast');
  try {
    await r.sync.liveSession(); unreported(r.fixture, 'modern');
    await assert.rejects(r.sync.push(r.plan, () => true, () => {}), /main\.tex changed on Overleaf/);
    assert.equal(r.fixture.replies.modern[0].content, 'Changed without a report.\n', 'Nothing was written over it');
  } finally { await r.close(); }
});
