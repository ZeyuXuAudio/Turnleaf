import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectStore, SyncHistory } from '../src/core/projectStore';
import { ReviewWorkflow, SyncService, incomingComments, outgoingComments, remoteTexts, sameContent, sameRemote, projectedInspection } from '../src/core/folderWorkflow';
import { OverleafReader } from '../src/core/overleaf';
import { readSaved } from '../src/core/savedFiles';
import type { Inspection } from '../src/core/models';
import { anchorLabel, rememberAnchors, reviewRows, textGone } from '../src/core/review';
import type { Cache } from '../src/core/storage';
import { fixtureCookie, startFixtureServer } from './fixtureServer';

const inspection = (text: string, pos: number, length: number): Inspection => ({ projectId: 'p', projectName: 'P', fetchedAt: '', missingFiles: [], unassignedThreadCount: 0,
  threads: { t1: { id: 't1', resolved: false, messages: [{ id: 'm', author: 'A', text: 'Check this.' }] } },
  docs: [{ path: 'main.tex', docId: 'd', otType: 'sharejs-text-ot', version: 1, text, changes: [], diagnostics: [], comments: [{ threadId: 't1', ranges: [{ pos, length }], state: 'placed' }] }] });

test('cached reviews resolve old suggestion author IDs without changing the sync baseline', () => {
  const acknowledged = inspection('Sample text.', 0, 6);
  acknowledged.threads.t1.messages[0] = { author: 'Named Reviewer', authorId: 'reviewer-id', text: 'Check this.' };
  acknowledged.docs[0].changes = [{ id: 's', kind: 'insert', pos: 0, text: 'Sample', author: 'reviewer-id' }];
  const projected = projectedInspection({ schema: 2, acknowledged, pending: [], anchors: {}, reviews: {} })!;
  assert.equal(projected.docs[0].changes[0].author, 'Named Reviewer');
  assert.equal(projected.docs[0].changes[0].authorId, 'reviewer-id');
  assert.equal(acknowledged.docs[0].changes[0].author, 'reviewer-id');
  assert.equal(acknowledged.docs[0].changes[0].authorId, undefined);
});

test('a deleted passage keeps the text a regular check remembered, and unchanged checks write nothing', () => {
  const cache = { schema: 1 as const, anchors: {} as Cache['anchors'] };
  const before = inspection('Intro.\nDrift is 0.64.\n', 16, 4);
  const placed = reviewRows(before, cache, {});
  assert.equal(rememberAnchors(cache, placed), true);
  assert.equal(rememberAnchors(cache, placed), false, 'Nothing changed, so nothing needs saving');
  assert.deepEqual(cache.anchors.t1, { path: 'main.tex', line: 2, excerpt: '0.64' });

  const after = inspection('Replaced.\n', 0, 0);
  after.docs[0].comments[0].state = 'anchor removed';
  const [removed] = reviewRows(after, cache, {});
  assert.equal(removed.anchor.label, 'anchor removed');
  assert.equal(removed.excerpt, '0.64');
  assert.equal(anchorLabel(removed.anchor.label), 'Text deleted');
  assert.equal(textGone(removed.anchor.label), true);
  assert.equal(rememberAnchors(cache, [removed]), false, 'The collapse point never replaces the last known place');
  assert.equal(cache.anchors.t1.line, 2);
  assert.equal(incomingComments(before, after)[0].label, 'Commented text deleted');
});

test('an anchor that only moves with edits above it is not an incoming comment change', () => {
  const before = inspection('Intro.\nDrift is 0.64.\n', 16, 4);
  assert.deepEqual(incomingComments(before, inspection('New line.\nIntro.\nDrift is 0.64.\n', 26, 4)), []);
  const [edited] = incomingComments(before, inspection('Intro.\nDrift is 0.42.\n', 16, 4));
  assert.equal(edited.label, 'Anchor text changed');
  assert.equal(edited.anchorBefore, '0.64'); assert.equal(edited.anchorText, '0.42');
  const moved = structuredClone(before); moved.threads.t1.messages.push({ id: 'r', author: 'B', text: 'Agreed.' });
  assert.equal(incomingComments(before, moved)[0].label, 'Updated thread');
  // Cards show where a change applies and what it is on, without counting moves as changes.
  assert.equal(edited.line, 2); assert.equal(edited.threadId, 't1');
  const [reply] = outgoingComments(before, [{ id: 'r1', kind: 'reply', path: 'main.tex', docId: 'd', threadId: 't1', text: 'Fixed.', created: '' }]);
  assert.deepEqual({ line: reply.line, threadId: reply.threadId, anchorText: reply.anchorText, author: reply.after?.messages.at(-1)?.author }, { line: 2, threadId: 't1', anchorText: '0.64', author: 'You' });
});

test('a first sync of a differing file offers either version instead of a whole-file conflict', async () => {
  const fixture = await startFixtureServer({ writable: true }), root = await mkdtemp(join(tmpdir(), 'overleaf-first-'));
  try {
    const reader = new OverleafReader(fixture.baseUrl, fixtureCookie), paths = ['main.tex', 'references.bib'];
    const remote = remoteTexts(await reader.inspect('test-project', paths));
    await writeFile(join(root, 'main.tex'), 'My own draft.\n'); await writeFile(join(root, 'references.bib'), remote['references.bib']);
    const workflow = new ReviewWorkflow(new SyncService(new ProjectStore(root, fixture.baseUrl, 'test-project', paths), reader));
    const plan = await workflow.preparePull(), file = plan.files.find(f => f.path === 'main.tex')!;
    assert(file.conflict && file.firstSync, 'No shared baseline: the user chooses');
    assert(!plan.files.some(f => f.path === 'references.bib'), 'Identical files are accepted silently');
    const keep = workflow.resolve(plan, 'main.tex', file.before);
    await workflow.apply(keep, () => true);
    assert.equal((await readSaved(root, paths))['main.tex'], 'My own draft.\n', 'Keeping a version leaves the file untouched');
    const send = await workflow.prepareSend();
    assert.equal(send.files.length, 1, 'The kept version becomes the outgoing change');
  } finally { await fixture.close(); await rm(root, { recursive: true, force: true }); }
});

test('history keeps recent and still-needed records and stores each file text once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'overleaf-history-'));
  try {
    const store = new ProjectStore(root, 'https://www.overleaf.com', 'p', ['main.tex']);
    await store.init(); store.retention = () => ({ records: 2, days: 0 });
    const shared = 'Shared text.\n'.repeat(100);
    const record = (n: number, outcome: SyncHistory['outcome']): SyncHistory => ({ ...store.newHistory('send', [{ path: 'main.tex', before: shared, after: `Version ${n}\n` }], []), id: `${1000 + n}-r`, time: new Date(Date.UTC(2026, 0, n)).toISOString(), outcome });
    await store.writeHistory(record(1, 'uncertain'));
    for (const n of [2, 3, 4]) await store.writeHistory(record(n, 'success'));
    const kept = await store.history();
    assert.deepEqual(kept.map(entry => entry.id), ['1004-r', '1003-r', '1001-r'], 'The newest two plus the uncertain record remain');
    assert.equal(kept[0].files[0].before, shared, 'Stored references resolve back to the exact text');
    const blobs = await readdir(join(root, '.turnleaf/projects', store.key, 'history/blobs'));
    assert.equal(blobs.length, 4, 'One shared before-text and three distinct after-texts; version 2 was removed with its record');
    assert.equal(await store.pruneHistory(1, 0), 1);
    assert.deepEqual((await store.history()).map(entry => entry.id), ['1004-r', '1001-r']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Send merges non-overlapping Overleaf edits first and names overlapping ones', async () => {
  const fixture = await startFixtureServer({ writable: true }), root = await mkdtemp(join(tmpdir(), 'overleaf-combined-'));
  try {
    const base = 'Intro.\n\nMethods.\n\nResults.\n';
    fixture.replies.modern[0] = { content: base, comments: [], trackedChanges: [] };
    const reader = new OverleafReader(fixture.baseUrl, fixtureCookie), paths = ['main.tex', 'references.bib'];
    for (const [path, text] of Object.entries(remoteTexts(await reader.inspect('test-project', paths)))) await writeFile(join(root, path), text);
    const sync = new SyncService(new ProjectStore(root, fixture.baseUrl, 'test-project', paths), reader), workflow = new ReviewWorkflow(sync);
    await workflow.apply(await workflow.preparePull(), () => true);
    const remote = (text: string) => { fixture.replies.modern[0] = { content: text, comments: [], trackedChanges: [] }; fixture.replies.modern[1]++; };
    remote('Intro, revised by a co-author.\n\nMethods.\n\nResults.\n');
    await writeFile(join(root, 'main.tex'), 'Intro.\n\nMethods.\n\nResults, with my numbers.\n');
    const plan = await workflow.prepareSend();
    assert(plan.incoming, 'The co-author edit is part of this review');
    assert.equal(plan.files[0].text, 'Intro, revised by a co-author.\n\nMethods.\n\nResults, with my numbers.\n', 'Only my edit is added on top of Overleaf');
    const applied = await workflow.apply(plan.incoming, () => true);
    await sync.push(workflow.afterIncoming(plan, applied), () => true, () => {});
    assert.equal(fixture.replies.modern[0].content, plan.files[0].text);
    assert.equal((await readSaved(root, paths))['main.tex'], plan.files[0].text, 'Local and Overleaf end identical');
    remote('Intro, revised by a co-author.\n\nMethods.\n\nResults: theirs.\n');
    await writeFile(join(root, 'main.tex'), 'Intro, revised by a co-author.\n\nMethods.\n\nResults: mine.\n');
    await assert.rejects(workflow.prepareSend(), (error: any) => error.code === 'incoming' && /main\.tex \(near line 5\)/.test(error.message));
  } finally { await fixture.close(); await rm(root, { recursive: true, force: true }); }
});

test('Send never re-inserts text a reviewer suggested deleting, and tracks only the author edit', async () => {
  const fixture = await startFixtureServer({ writable: true }), root = await mkdtemp(join(tmpdir(), 'overleaf-edit-'));
  try {
    const base = 'Keep this.\nThe third needs recalibration.\nEnd.\n';
    fixture.replies.modern[0] = { content: base, comments: [{ id: 'c1', ranges: [{ pos: 0, length: 4 }] }], trackedChanges: [] };
    const reader = new OverleafReader(fixture.baseUrl, fixtureCookie), paths = ['main.tex', 'references.bib'];
    for (const [path, text] of Object.entries(remoteTexts(await reader.inspect('test-project', paths)))) await writeFile(join(root, path), text);
    const sync = new SyncService(new ProjectStore(root, fixture.baseUrl, 'test-project', paths), reader), workflow = new ReviewWorkflow(sync);
    await workflow.apply(await workflow.preparePull(), () => true);
    // After the last sync a reviewer suggests deleting the middle sentence (Track Changes on).
    const sentence = 'The third needs recalibration.\n', start = base.indexOf(sentence);
    fixture.replies.modern[0].trackedChanges = [{ range: { pos: start, length: sentence.length }, tracking: { type: 'delete', userId: 'reviewer', ts: '2026-10-28T14:11:26.000Z' } }];
    fixture.replies.modern[1]++;
    await writeFile(join(root, 'main.tex'), base.replace('End.', 'End, extended.'));
    const plan = await workflow.prepareSend();
    await sync.push(workflow.afterIncoming(plan, await workflow.apply(plan.incoming!, () => true)), () => true, () => {});
    const raw = fixture.replies.modern[0];
    assert.equal(raw.content, base.replace('End.', 'End, extended.'), 'The suggested deletion keeps its text in place');
    assert.deepEqual(raw.trackedChanges.map((c: any) => [c.tracking.type, c.tracking.userId, raw.content.slice(c.range.pos, c.range.pos + c.range.length)]),
      [['delete', 'reviewer', sentence], ['insert', '0123456789abcdef01234567', ', extended']], 'One reviewer suggestion untouched, one new suggestion for the author edit');
    assert.equal(fixture.requests.filter(r => r.path.endsWith('/upload')).length, 0, 'No whole-file upload');
    assert.equal((await readSaved(root, paths))['main.tex'], 'Keep this.\nEnd, extended.\n', 'The suggested deletion now shows locally too');
  } finally { await fixture.close(); await rm(root, { recursive: true, force: true }); }
});

test('a baseline saved before suggestion author IDs still matches Overleaf', () => {
  const older = inspection('Intro.\nDrift is 0.64.\n', 16, 4);
  older.docs[0].changes = [{ id: 'd:1:0', kind: 'insert', pos: 0, text: 'Intro', author: 'reviewer-id', timestamp: '2026-10-31T10:00:00Z' }];
  const fresh = structuredClone(older);
  Object.assign(fresh.docs[0].changes[0], { author: 'Named Reviewer', authorId: 'reviewer-id' });
  assert(sameContent(older, fresh), 'Only the author details differ');
  for (const change of [{ text: 'Other' }, { pos: 1 }, { kind: 'delete' as const }, { timestamp: '2026-11-01T10:00:00Z' }]) {
    const moved = structuredClone(fresh); Object.assign(moved.docs[0].changes[0], change);
    assert(!sameContent(older, moved), `A real suggestion change still counts: ${Object.keys(change)[0]}`);
  }
  const removed = structuredClone(fresh); removed.docs[0].changes = [];
  assert(!sameContent(older, removed), 'A removed suggestion still counts');
});

test('an edit that was undone on Overleaf leaves nothing incoming', async () => {
  const before = inspection('Intro.\nDrift is 0.64.\n', 16, 4);
  before.docs[0].changes = [{ id: 'd:1:0', kind: 'insert', pos: 0, text: 'Intro', author: 'A' }];
  const undone = structuredClone(before); undone.docs[0].version = 3; undone.docs[0].changes[0].id = 'd:3:0';
  assert(sameContent(before, undone) && !sameRemote(before, undone), 'Content matches; the version still marks a write as stale');
  const edited = structuredClone(undone); edited.docs[0].text = 'Intro!\nDrift is 0.64.\n';
  assert(!sameContent(before, edited));
  const commented = structuredClone(undone); commented.threads.t1.resolved = true;
  assert(!sameContent(before, commented));
  const fixture = await startFixtureServer({ writable: true }), root = await mkdtemp(join(tmpdir(), 'overleaf-undone-'));
  try {
    fixture.replies.modern[0] = { content: 'Intro.\n', comments: [], trackedChanges: [] };
    const reader = new OverleafReader(fixture.baseUrl, fixtureCookie), paths = ['main.tex', 'references.bib'];
    for (const [path, text] of Object.entries(remoteTexts(await reader.inspect('test-project', paths)))) await writeFile(join(root, path), text);
    const workflow = new ReviewWorkflow(new SyncService(new ProjectStore(root, fixture.baseUrl, 'test-project', paths), reader));
    await workflow.apply(await workflow.preparePull(), () => true);
    fixture.replies.modern[1] += 2; // typed, then deleted again
    await writeFile(join(root, 'main.tex'), 'Intro, edited.\n');
    const plan = await workflow.prepareSend();
    assert.equal(plan.incoming, undefined, 'No Apply & send for a version-only change');
    assert.equal(plan.files.length, 1);
  } finally { await fixture.close(); await rm(root, { recursive: true, force: true }); }
});
