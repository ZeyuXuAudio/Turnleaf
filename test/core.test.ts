import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { normalizeDoc, validateTrackedFiles } from '../src/core/docState';
import { decodePackets } from '../src/core/socket';
import { ReadTransport, normalizeBaseUrl } from '../src/core/http';
import { OverleafReader, parseProjects } from '../src/core/overleaf';
import { SessionExpiredError, safeError } from '../src/core/errors';
import { inspectionCounts, renderInspection } from '../src/core/report';
import { describeShape, ProbeRecorder, summarizeInspection, summarizeJoinProject } from '../src/core/probe';
import type { Inspection } from '../src/core/models';
import { fixtureCookie, fixtureOwner, legacyReply, modernReply, startFixtureServer } from './fixtureServer';

test('tracked edits resolve comment authors absent from project membership, including thread-only refreshes', async () => {
  const fixture = await startFixtureServer();
  const reader = new OverleafReader(fixture.baseUrl, fixtureCookie);
  let session;
  try {
    session = await reader.openSession('test-project', ['main.tex', 'references.bib'], { live: true });
    const initial = session.inspection;
    for (const doc of initial.docs) for (const change of doc.changes) {
      assert.equal(change.author, 'Fixture Reviewer');
      assert.equal(change.authorId, 'reviewer');
    }
    for (const thread of Object.values(fixture.threads)) for (const message of thread.messages) {
      if (message.user.id === 'reviewer') message.user = { _id: 'reviewer', first_name: 'Named', last_name: 'Reviewer' };
    }
    const refreshed = await session.refresh({ docs: [] });
    assert(refreshed.docs.every(doc => doc.changes.every(change => change.author === 'Named Reviewer')));
    assert(initial.docs.every(doc => doc.changes.every(change => change.author === 'Fixture Reviewer')), 'Refreshing must not mutate an existing review');
    fixture.replies.modern[0].trackedChanges[0].tracking.userId = 'unavailable-reviewer';
    const unknown = await session.refresh({ docs: ['modern'] });
    assert.equal(unknown.docs[0].changes[0].author, 'Unknown author');
    assert.equal(unknown.docs[0].changes[0].authorId, 'unavailable-reviewer');
  } finally { await session?.close(); await fixture.close(); }
});

test('history-ot removes tracked deletes and remaps every range, retaining lost/unknown anchors', () => {
  const doc = normalizeDoc('main.tex', 'modern', modernReply);
  assert.equal(doc.text, 'Alpha βeta.\nSecond line.\n');
  assert.deepEqual(doc.comments[1].ranges, [{ pos: 6, length: 0 }, { pos: 6, length: 4 }]);
  assert.equal(doc.comments[2].state, 'anchor removed');
  assert.equal(doc.comments[3].state, 'position unknown');
  assert.deepEqual(doc.comments[3].ranges, []);
  assert.deepEqual(doc.changes.map(c => [c.kind, c.pos, c.text]), [['delete', 6, 'old '], ['insert', 6, 'βeta']]);
});

test('legacy UTF-8 encoding is decoded before positions are validated', () => {
  const doc = normalizeDoc('references.bib', 'legacy', legacyReply);
  assert.equal(doc.text, 'Jörg cite.\n');
  assert.deepEqual(doc.comments[0].ranges, [{ pos: 0, length: 4 }]);
  const wrong = structuredClone(legacyReply) as any[];
  wrong[3].comments[0].op.p = 5;
  assert.equal(normalizeDoc('references.bib', 'legacy', wrong).comments[0].state, 'position unknown');
});

test('history-ot distinguishes hidden anchors from removed, visible and invalid anchors', () => {
  const raw = {
    content: 'AoldB',
    comments: [
      { id: 'hidden', ranges: [{ pos: 1, length: 3 }] },
      { id: 'removed', ranges: [] },
      { id: 'partial', ranges: [{ pos: 0, length: 2 }, { pos: 3, length: 2 }] },
      { id: 'invalid', ranges: [{ pos: 99, length: 1 }] },
      { id: 'empty', ranges: [{ pos: 1, length: 0 }] },
    ],
    trackedChanges: [{ range: { pos: 1, length: 3 }, tracking: { type: 'delete', userId: 'reviewer' } }],
  };
  const doc = normalizeDoc('main.tex', 'doc', [raw, 1, [], {}, 'history-ot']);
  assert.equal(doc.text, 'AB');
  assert.deepEqual(doc.comments.map(c => c.state), ['hidden', 'anchor removed', 'placed', 'position unknown', 'anchor removed']);
  assert.deepEqual(doc.comments[0].ranges, [{ pos: 1, length: 0 }]);
  assert.deepEqual(doc.comments[0].rawRanges, [{ pos: 1, length: 3 }]);
  assert.deepEqual(doc.comments[2].ranges, [{ pos: 0, length: 1 }, { pos: 1, length: 1 }]);
  assert.equal(doc.comments[3].rawRanges, undefined);
  assert.equal(doc.diagnostics.length, 1);
  const inspection: Inspection = { projectId: 'project', projectName: 'Fixture', fetchedAt: '', docs: [doc],
    threads: Object.fromEntries(raw.comments.map(c => [c.id, { id: c.id, resolved: false, messages: [] }])), missingFiles: [], unassignedThreadCount: 0 };
  assert.match(renderInspection(inspection), /hidden · open · anchor in a suggested deletion · line 1/);
  assert.deepEqual(summarizeInspection(inspection).docs[0].anchors, { placed: 1, hidden: 1, 'anchor removed': 2, 'position unknown': 1 });
  const rejected = normalizeDoc('main.tex', 'doc', [{ ...raw, trackedChanges: [] }, 2, [], {}, 'history-ot']);
  assert.equal(rejected.comments[0].state, 'placed');
  assert.deepEqual(rejected.comments[0].ranges, [{ pos: 1, length: 3 }]);
  const accepted = normalizeDoc('main.tex', 'doc', [{ content: 'AB', comments: [{ id: 'hidden', ranges: [] }], trackedChanges: [] }, 2, [], {}, 'history-ot']);
  assert.equal(accepted.comments[0].state, 'anchor removed');
  raw.comments[0].ranges[0].pos = 4;
  assert.deepEqual(doc.comments[0].rawRanges, [{ pos: 1, length: 3 }], 'raw ranges must not alias the reply');
});

test('legacy decoding preserves U+FEFF in lines, anchors and inserted/deleted suggestions', () => {
  const escape = (text: string) => Buffer.from(text, 'utf8').toString('latin1');
  const lines = ['\uFEFFFirst', '\uFEFFSecond', 'x\uFEFFinsert'];
  const text = lines.join('\n'), snippet = '\uFEFFinsert', pos = text.indexOf(snippet);
  const reply = [lines.map(escape), 1, [], {
    comments: [{ op: { t: 'comment', p: pos, c: escape(snippet) } }, { op: { t: 'second', p: text.indexOf('Second'), c: 'Second' } }],
    changes: [{ op: { p: pos, i: escape(snippet) } }, { op: { p: 0, d: escape('\uFEFFdeleted') } }],
  }, 'sharejs-text-ot'];
  const doc = normalizeDoc('main.tex', 'doc', reply);
  assert.equal(doc.text, text);
  assert.deepEqual(doc.comments.map(c => c.state), ['placed', 'placed']);
  assert.deepEqual(doc.comments[0].ranges, [{ pos, length: snippet.length }]);
  assert.deepEqual(doc.changes.map(c => c.text), [snippet, '\uFEFFdeleted']);
  assert.deepEqual(doc.diagnostics, []);
  assert.throws(() => normalizeDoc('main.tex', 'doc', [['\xff'], 1, [], {}, 'sharejs-text-ot']), /unsupported response/);
});

test('malformed ranges, framing and tracked paths fail instead of producing guessed positions', () => {
  const wrong = structuredClone(modernReply) as any[];
  wrong[0].trackedChanges[0].range.length = 999;
  assert.throws(() => normalizeDoc('main.tex', 'modern', wrong));
  for (const path of ['../secret.tex', '/main.tex', 'a/../main.tex', 'image.png', 'a\\main.tex']) assert.throws(() => validateTrackedFiles([path]));
  // No files chosen yet is a valid setting, but nothing can be read with it.
  assert.deepEqual(validateTrackedFiles([], { allowEmpty: true }), []);
  assert.throws(() => validateTrackedFiles([]), /Choose the source files to synchronize first/);
  assert.throws(() => decodePackets('\ufffd8\ufffdshort'));
  assert.throws(() => decodePackets('\ufffdx\ufffdpayload'));
  assert.deepEqual(decodePackets('\ufffd3\ufffd2::\ufffd3\ufffd8::'), ['2::', '8::']);
});

test('HTML project lists support entities and an empty list; login is an auth failure', () => {
  assert.deepEqual(parseProjects('<meta name="ol-projects" content="[]">'), []);
  assert.equal(parseProjects('<meta name="ol-prefetchedProjectsBlob" content="{&quot;projects&quot;:[{&quot;id&quot;:&quot;p&quot;,&quot;name&quot;:&quot;A &amp; B&quot;}]}">')[0].name, 'A & B');
  assert.throws(() => parseProjects('<form action="/login"></form>'), SessionExpiredError);
  assert.throws(() => parseProjects('<html>No supported project data</html>'));
  assert.throws(() => parseProjects('<meta name="unrelated-list" content="[]">'));
});

test('read-only sign-in and inspection work end to end through HTTP and framed socket replies', async () => {
  const fixture = await startFixtureServer();
  try {
    const reader = new OverleafReader(fixture.baseUrl, fixtureCookie);
    assert.equal((await reader.signIn())[0].name, 'Fixture Review');
    assert.equal(fixture.requests.length, 2);
    const result = await reader.inspect('test-project', ['main.tex', 'references.bib', 'missing.sty']);
    assert.equal(result.docs.length, 2);
    assert.deepEqual(result.missingFiles, ['missing.sty']);
    assert.equal(result.unassignedThreadCount, 1);
    assert.deepEqual(inspectionCounts(result), { open: 4, suggestions: 3 });
    const report = renderInspection(result);
    assert.match(report, /position unknown/);
    assert.match(report, /anchor removed/);
    assert(!report.includes(fixtureCookie));
    assert.equal(fixture.sockets.size, 0);
    assert(fixture.requests.filter(r => r.method === 'POST').every(r => r.path.startsWith('/socket.io/1/xhr-polling/')));
    assert(fixture.requests.filter(r => r.packet?.startsWith('5:')).every(r => /"name":"(?:joinDoc|leaveDoc)"/.test(r.packet!)));
  } finally { await fixture.close(); }
});

test('the live probe recorder keeps shapes and counts, never text, names, values or IDs', async () => {
  const fixture = await startFixtureServer();
  try {
    const probe = new ProbeRecorder();
    const reader = new OverleafReader(fixture.baseUrl, fixtureCookie, probe);
    assert.equal((await reader.listProjects()).length, 1);
    const started = new Date();
    probe.inspected(await reader.inspect('test-project', ['main.tex', 'references.bib', 'missing.sty']));
    probe.finished('turnleaf.inspectProject', started);
    probe.finished('turnleaf.inspectProject', started, new SessionExpiredError());
    const snapshot = probe.snapshot();
    assert.deepEqual(snapshot.projectPage, { userIdMetaTag: true, userIdIsObjectId: true });
    assert.deepEqual(snapshot.joinProject, {
      responseKeys: ['permissionsLevel', 'project', 'protocolVersion', 'publicId'], projectKeys: ['name', 'owner', 'rootDoc_id', 'rootFolder', 'trackChangesState'],
      trackChangesFields: { trackChangesState: { type: 'object', keys: ['__guests__'], objectIdKeys: 1, otherKeys: 0, values: [{ type: 'boolean' }] } },
      trackChangesHasOwnerKey: true, trackChangesState: 'object', trackChangesHasUserKey: true, rootDoc: 'main.tex',
    });
    const [ok, expired] = snapshot.outcomes;
    assert.deepEqual(ok.joinProject, snapshot.joinProject);
    assert.equal(expired.joinProject, undefined);
    assert.equal(summarizeJoinProject({ project: { trackChangesState: false } }, fixtureOwner).trackChangesState, 'boolean');
    assert.equal(summarizeJoinProject({ project: {} }).trackChangesState, 'missing');
    assert.equal(summarizeJoinProject({ project: { trackChangesState: { [fixtureOwner]: true } } }, 'ffffffffffffffffffffffff').trackChangesHasUserKey, false);
    assert.deepEqual(ok.inspection?.docs.map(doc => [doc.path, doc.otType, doc.version, doc.anchors, doc.suggestions, doc.warnings]), [
      ['main.tex', 'history-ot', 7, { placed: 2, hidden: 0, 'anchor removed': 1, 'position unknown': 1 }, { insert: 1, delete: 1 }, { 'inconsistent anchor': 1 }],
      ['references.bib', 'sharejs-text-ot', 9, { placed: 1, hidden: 0, 'anchor removed': 0, 'position unknown': 0 }, { insert: 0, delete: 1 }, {}],
    ]);
    assert.deepEqual(ok.inspection?.projectThreads, { total: 6, open: 5, resolved: 1, messages: 6 });
    assert.equal(ok.inspection?.missingFiles, 1);
    assert.deepEqual(expired.error, { code: 'session-expired', message: 'Overleaf session expired' });
    const text = JSON.stringify(snapshot);
    for (const secret of [fixtureCookie, fixtureOwner, 'Fixture Review', 'Fixture Reviewer', 'reviewer', 'Alpha', 'Jörg', 'verify the claim', 'test-project', 'modern', 'legacy', 'c1', 'fixture-public', ':"owner"']) {
      assert(!text.includes(secret), secret);
    }
    assert.deepEqual(describeShape({ 'ada@example.test': 1, a1: [true, 'x'] }), { type: 'object', keys: [], objectIdKeys: 0, otherKeys: 2, values: [{ type: 'number' }, { type: 'array', length: 2, items: [{ type: 'boolean' }, { type: 'string' }] }] });
  } finally { await fixture.close(); }
});

test('one 403 reboots the session; a repeated 403 becomes a session-expired error', async () => {
  const fixture = await startFixtureServer();
  try {
    const reader = new OverleafReader(fixture.baseUrl, fixtureCookie);
    fixture.forbidNextThreadReads(1);
    await reader.inspect('test-project', ['main.tex']);
    fixture.forbidNextThreadReads(2);
    await assert.rejects(() => reader.inspect('test-project', ['main.tex']), SessionExpiredError);
    await assert.rejects(() => new OverleafReader(fixture.baseUrl, 'wrong-cookie').signIn(), SessionExpiredError);
  } finally { await fixture.close(); }
});

test('origin policy blocks cross-port redirects before the target receives credentials', async () => {
  let targetRequests = 0;
  const target = createServer((_req, res) => { targetRequests++; res.end('unexpected'); });
  await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
  const targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
  const source = createServer((req, res) => {
    if (req.url === '/same') res.writeHead(302, { Location: '/ok' }).end();
    else if (req.url === '/ok') res.end('okay');
    else if (req.url?.startsWith('/socket.io/')) res.writeHead(307, { Location: '/project/mutation' }).end();
    else res.writeHead(302, { Location: targetUrl }).end();
  });
  await new Promise<void>(resolve => source.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(source.address() as AddressInfo).port}`;
  try {
    const transport = new ReadTransport(baseUrl, fixtureCookie);
    assert.equal(await transport.get(baseUrl + '/same'), 'okay');
    await assert.rejects(() => transport.get(baseUrl + '/different'), /outside the configured/);
    const secure = new ReadTransport('https://example.test', fixtureCookie);
    await assert.rejects(() => secure.get('http://example.test/project'), /outside the configured/);
    await assert.rejects(() => transport.postSocket(baseUrl + '/socket.io/1/xhr-polling/x', '5:1+::{"name":"applyOtUpdate","args":[]}'), /Blocked a write/);
    await assert.rejects(() => transport.postSocket(baseUrl + '/socket.io/1/xhr-polling/x', '2::'), /different endpoint/);
    assert.equal(targetRequests, 0);
    assert.equal(normalizeBaseUrl('HTTPS://EXAMPLE.TEST:443/'), 'https://example.test');
    assert.throws(() => new ReadTransport(baseUrl, 'value\r\nCookie: other'));
    assert(!safeError(new Error(fixtureCookie)).includes(fixtureCookie));
  } finally {
    await new Promise<void>(resolve => source.close(() => resolve()));
    await new Promise<void>(resolve => target.close(() => resolve()));
  }
});
