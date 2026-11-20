import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { normalizeDoc } from '../src/core/docState';
import { Decision, findSuggestion, historyDecisionOp, rejectLocally, shareJsRejectOp, suggestionAuthors, suggestionRef, suggestionsInRange, visibleAfter } from '../src/core/suggestions';
import { ProjectStore, CommentDraft } from '../src/core/projectStore';
import { ReviewWorkflow, SyncService, remoteTexts } from '../src/core/folderWorkflow';
import { OverleafReader } from '../src/core/overleaf';
import { readSaved } from '../src/core/savedFiles';
import { fixtureCookie, startFixtureServer } from './fixtureServer';
const File = require(resolve('test/reference/editor-core/lib/file_data/string_file_data.js'));
const TextOperation = require(resolve('test/reference/editor-core/lib/operation/text_operation.js'));
const Tracker = require(resolve('test/reference/ranges-tracker.cjs'));
const escape = (s: string) => Buffer.from(s).toString('latin1');

const reviewer = (type: 'insert' | 'delete', ts: string) => ({ type, userId: 'reviewer', ts });
const raw = () => ({ content: 'Keep old new words. Tail added here.', comments: [{ id: 'c', ranges: [{ pos: 0, length: 4 }] }],
  trackedChanges: [{ range: { pos: 5, length: 4 }, tracking: reviewer('delete', '2026-10-30T09:00:00.000Z') }, { range: { pos: 9, length: 4 }, tracking: reviewer('insert', '2026-10-30T09:00:01.000Z') }, { range: { pos: 25, length: 6 }, tracking: reviewer('insert', '2026-10-30T09:00:02.000Z') }] });

test('suggestion decisions survive author-name resolution without confusing two authors with the same name', () => {
  const doc = normalizeDoc('main.tex', 'd', [raw(), 3, [], {}, 'history-ot']);
  const ref = suggestionRef(doc.changes[0]);
  doc.changes[0].author = 'Named Reviewer';
  assert.equal(findSuggestion(doc, ref), 0);
  const { authorId, ...olderDecision } = ref;
  assert.equal(findSuggestion(doc, olderDecision), 0, 'A saved decision from before author IDs were stored still matches');
  const namedRef = suggestionRef(doc.changes[0]);
  doc.changes[0].authorId = 'different-reviewer';
  assert.equal(findSuggestion(doc, namedRef), -1, 'A shared display name is not a shared identity');
});

test('a selection takes the insertions it overlaps and the deletions inside it, edges included', () => {
  const s = (id: string, kind: 'insert' | 'delete', pos: number, text: string) => ({ id, kind, pos, text });
  const changes = [s('before', 'insert', 0, 'ab'), s('overlapStart', 'insert', 3, 'cdef'), s('inside', 'insert', 8, 'g'), s('overlapEnd', 'insert', 11, 'hijk'),
    s('after', 'insert', 15, 'l'), s('deleteAtStart', 'delete', 5, 'x'), s('deleteAtEnd', 'delete', 12, 'y'), s('deleteOutside', 'delete', 13, 'z')];
  const ids = (from: number, to: number) => suggestionsInRange(changes, from, to).map(c => c.id);
  assert.deepEqual(ids(5, 12), ['overlapStart', 'inside', 'overlapEnd', 'deleteAtStart', 'deleteAtEnd']);
  assert.deepEqual(ids(2, 3), [], 'An insertion that only touches an edge is outside');
  assert.deepEqual(ids(0, 20).length, changes.length);
});

test('suggestions group by author ID, keeping two authors who share a name apart', () => {
  const s = (id: string, author: string, authorId?: string) => ({ id, author, ...authorId && { authorId } });
  const authors = suggestionAuthors([s('1', 'Ada', 'u1'), s('2', 'Ben', 'u2'), s('3', 'Ada', 'u1'), s('4', 'Ada', 'u3'), s('5', 'Old'), s('6', 'Old')]);
  assert.deepEqual(authors.map(a => [a.key, a.name, a.suggestions.map(x => x.id)]), [['u1', 'Ada', ['1', '3']], ['u2', 'Ben', ['2']], ['u3', 'Ada', ['4']], ['Old', 'Old', ['5', '6']]]);
});

test('history-ot decisions match the pinned Overleaf editor core for every kind', () => {
  for (const index of [0, 1, 2]) for (const decision of ['accept', 'reject'] as Decision[]) {
    const doc = normalizeDoc('main.tex', 'd', [raw(), 3, [], {}, 'history-ot']), suggestion = doc.changes[index];
    const file = File.fromRaw(raw());
    file.edit(TextOperation.fromJSON({ textOperation: historyDecisionOp(doc, index, decision) }));
    const after = normalizeDoc('main.tex', 'd', [file.toRaw(), 4, [], {}, 'history-ot']);
    assert.equal(after.text, visibleAfter(doc.text, suggestion, decision), `${decision} ${suggestion.kind} ${index}`);
    assert.equal(findSuggestion(after, suggestionRef(suggestion)), -1, 'The decided suggestion is gone');
    assert.deepEqual(after.changes.map(c => c.text), doc.changes.filter((_, n) => n !== index).map(c => c.text), 'Other suggestions stay');
    assert.equal(after.comments[0].state, 'placed');
  }
});

test('sharejs rejections cancel the suggestion in the pinned range tracker', () => {
  const text = 'Keep new words.';
  for (const change of [{ id: 'ins', op: { p: 5, i: 'new ' } }, { id: 'del', op: { p: 5, d: 'old ' } }] as { id: string; op: { p: number; i: string } | { p: number; d: string } }[]) {
    const tracker = new Tracker([{ ...structuredClone(change), metadata: { user_id: 'reviewer', ts: '2026-10-30T09:00:00Z' } }], []);
    const doc = normalizeDoc('refs.bib', 'd', [[escape(text)], 2, [], { changes: [{ ...change, op: 'i' in change.op ? { p: 5, i: escape(change.op.i) } : { p: 5, d: escape(change.op.d) } }] }, 'sharejs-text-ot']);
    const op = shareJsRejectOp(doc.changes[0]);
    let next = text;
    for (const c of op) next = 'i' in c ? next.slice(0, c.p) + c.i + next.slice(c.p) : next.slice(0, c.p) + next.slice(c.p + c.d.length);
    tracker.applyOps(op, { user_id: 'author' });
    assert.equal(tracker.changes.length, 0, change.id);
    assert.equal(next, visibleAfter(doc.text, doc.changes[0], 'reject'));
  }
});

test('rejections follow local edits elsewhere and refuse edits inside the suggestion', () => {
  const remote = 'Alpha beta gamma.\nDelta.\n', inserted = { id: 'i', kind: 'insert' as const, pos: 6, text: 'beta ', author: 'R' }, deleted = { id: 'd', kind: 'delete' as const, pos: 18, text: 'Old ', author: 'R' };
  assert.equal(rejectLocally('main.tex', remote, 'Intro. Alpha beta gamma.\nDelta!\n', [inserted, deleted]), 'Intro. Alpha gamma.\nOld Delta!\n');
  assert.equal(rejectLocally('main.tex', remote, remote, [deleted, inserted]), 'Alpha gamma.\nOld Delta.\n');
  assert.throws(() => rejectLocally('main.tex', remote, 'Alpha bXeta gamma.\nDelta.\n', [inserted]), /edited the text of a suggestion you rejected \(near line 1\)/);
});

async function project() {
  const fixture = await startFixtureServer({ writable: true }), root = await mkdtemp(join(tmpdir(), 'overleaf-suggestions-'));
  fixture.replies.modern[0] = raw();
  const reader = new OverleafReader(fixture.baseUrl, fixtureCookie), paths = ['main.tex', 'references.bib'];
  const inspection = await reader.inspect('test-project', paths);
  for (const [path, text] of Object.entries(remoteTexts(inspection))) await writeFile(join(root, path), text);
  const state = new ProjectStore(root, fixture.baseUrl, 'test-project', paths), sync = new SyncService(state, reader), workflow = new ReviewWorkflow(sync);
  await workflow.apply(await workflow.preparePull(), () => true);
  const decide = (kind: 'acceptChange' | 'rejectChange', path: string, index: number): CommentDraft => {
    const doc = inspection.docs.find(doc => doc.path === path)!;
    return { id: randomUUID(), kind, path, docId: doc.docId, threadId: '', change: suggestionRef(doc.changes[index]), created: new Date().toISOString() };
  };
  return { fixture, root, paths, state, sync, workflow, inspection, decide, local: () => readSaved(root, paths, true),
    close: async () => { await fixture.close(); await rm(root, { recursive: true, force: true }); } };
}

test('accepting and rejecting suggestions sends them with local edits and updates the local files', async () => {
  const r = await project();
  try {
    const main = r.inspection.docs[0], bib = r.inspection.docs[1];
    assert.equal(main.text, 'Keep new words. Tail added here.'); assert.equal(bib.changes[0].text, 'draft ');
    await r.state.queue(r.decide('acceptChange', 'main.tex', 0)); // the deletion of "old "
    await r.state.queue(r.decide('rejectChange', 'main.tex', 2)); // the insertion "added "
    await r.state.queue(r.decide('acceptChange', 'references.bib', 0));
    await writeFile(join(r.root, 'main.tex'), 'Keep new words. Tail added here.\nMine.\n');
    await r.state.queue(r.decide('rejectChange', 'main.tex', 1)); // the insertion "new "
    // A later decision on the same suggestion replaces the earlier one: restore "draft ".
    await r.state.queue(r.decide('rejectChange', 'references.bib', 0));
    assert.equal((await r.state.read()).pending.length, 4);
    const plan = await r.workflow.prepareSend();
    assert.deepEqual(plan.comments.map(c => `${c.label}:${c.suggestion?.text}`), ['Accept suggestion:old ', 'Reject suggestion:added ', 'Reject suggestion:new ', 'Reject suggestion:draft ']);
    assert.equal(plan.local['main.tex'], 'Keep words. Tail here.\nMine.\n'); assert.equal(plan.local['references.bib'], 'Jörg draft cite.\n');
    assert.deepEqual(await r.local(), { 'main.tex': 'Keep new words. Tail added here.\nMine.\n', 'references.bib': 'Jörg cite.\n' }, 'Nothing changes locally before Send');
    const sent = await r.sync.push(plan, () => true, () => {});
    assert.deepEqual(remoteTexts(sent.inspection), plan.local);
    // Track Changes is on in the fixture, so only the local edit remains a suggestion.
    assert.deepEqual(sent.inspection.docs.map(doc => doc.changes.map(c => c.text)), [['\nMine.\n'], []], 'Every decided suggestion is gone');
    assert.equal(r.fixture.replies.modern[0].content, 'Keep words. Tail here.\nMine.\n', 'Accepted deletion removed, rejected insertions removed');
    assert.deepEqual(await r.local(), plan.local);
    const data = await r.state.read();
    assert.equal(data.pending.length, 0); assert.equal(data.localApply, undefined);
    assert.equal((await r.workflow.prepareSend()).files.length, 0, 'The local files and Overleaf agree afterwards');
    assert.deepEqual((await r.state.history())[0].completed.filter(step => !step.startsWith('suggestion:')), ['file:main.tex', 'file:references.bib', 'local:main.tex', 'local:references.bib']);
  } finally { await r.close(); }
});

test('sharejs accepts use the review route and keep the document version', async () => {
  const r = await project();
  try {
    await r.state.queue(r.decide('acceptChange', 'references.bib', 0));
    const sent = await r.sync.push(await r.workflow.prepareSend(), () => true, () => {});
    assert(r.fixture.requests.some(request => request.method === 'POST' && request.path === '/project/test-project/doc/legacy/changes/accept'));
    assert.equal(sent.inspection.docs[1].changes.length, 0); assert.equal(sent.inspection.docs[1].version, r.inspection.docs[1].version);
    assert.equal((await r.local())['references.bib'], 'Jörg cite.\n');
  } finally { await r.close(); }
});

test('a suggestion decided on Overleaf meanwhile, or edited locally before a rejection, stops the review', async () => {
  const r = await project();
  try {
    await r.state.queue(r.decide('rejectChange', 'main.tex', 1));
    await writeFile(join(r.root, 'main.tex'), 'Keep nXew words. Tail added here.');
    await assert.rejects(r.workflow.prepareSend(), /edited the text of a suggestion you rejected/);
    await writeFile(join(r.root, 'main.tex'), r.inspection.docs[0].text);
    r.fixture.replies.modern[0].trackedChanges.splice(1, 1); r.fixture.replies.modern[1]++;
    await assert.rejects(r.workflow.prepareSend(), /changed or decided on Overleaf/);
  } finally { await r.close(); }
});
