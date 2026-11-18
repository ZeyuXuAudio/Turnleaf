import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, unlink, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Inspection } from '../src/core/models';
import { ProjectStore, moveSelection } from '../src/core/projectStore';
import { LocalReviewFiles, ThreadFile } from '../src/core/reviewFiles';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'turnleaf-review-'));
  const inspection: Inspection = { projectId: 'test', projectName: 'Sample paper', fetchedAt: '2026-11-05T12:00:00Z', userId: 'me', missingFiles: [], unassignedThreadCount: 0,
    docs: [{ path: 'main.tex', docId: 'doc', otType: 'history-ot', version: 1, text: 'First line.\nSelected text.\n', changes: [], diagnostics: [], comments: [{ threadId: 'thread-1', state: 'placed', ranges: [{ pos: 12, length: 13 }] }, { threadId: 'thread-2', state: 'placed', ranges: [{ pos: 0, length: 5 }] }] }],
    threads: { 'thread-1': { id: 'thread-1', resolved: false, messages: [{ id: 'message-1', authorId: 'me', author: 'Author', text: 'Original message' }] }, 'thread-2': { id: 'thread-2', resolved: true, messages: [{ id: 'message-2', authorId: 'other', author: 'Collaborator', text: 'Another message' }] } } };
  const state = new ProjectStore(root, 'https://overleaf.test', 'test', ['main.tex']), files = new LocalReviewFiles(state);
  await state.update(data => { data.acknowledged = structuredClone(inspection); data.observed = structuredClone(inspection); data.revision = 'baseline'; });
  await files.enable();
  const path = (id = 'thread-1') => files.path(`threads/${id}.json`);
  const read = async (id?: string): Promise<ThreadFile> => JSON.parse(await readFile(await path(id), 'utf8'));
  const write = async (record: ThreadFile) => writeFile(await path(record.threadId), JSON.stringify(record, null, 2) + '\n');
  return { root, state, files, inspection, read, write, path, close: () => rm(root, { recursive: true, force: true }) };
}

test('review files expose indexed discussions, exact anchors and a readable overview without changing the baseline', async () => {
  const r = await fixture();
  try {
    const record = await r.read(), index = JSON.parse(await readFile(await r.files.path('index.json'), 'utf8'));
    assert.deepEqual(index.bySourceFile['main.tex'], ['thread-1', 'thread-2']);
    assert.equal(index.threads[0].file, 'threads/thread-1.json');
    assert.equal(record.baseline.anchor?.line, 2); assert.equal(record.baseline.anchor?.quotedText, 'Selected text');
    assert.equal(record.baseline.anchor?.documentId, 'doc');
    assert.deepEqual(record.remote.thread, r.inspection.threads['thread-1']);
    assert.deepEqual((await r.state.read()).acknowledged, r.inspection);
    assert.match(await readFile(await r.files.path(), 'utf8'), /Original message/);
    assert.match(await readFile(await r.files.path(), 'utf8'), /threads\/thread-1.json/);
    const first = await readFile(await r.path(), 'utf8'); await r.files.sync(); assert.equal(await readFile(await r.path(), 'utf8'), first, 'No-op refresh keeps generations and bytes stable');
  } finally { await r.close(); }
});

test('JSON replies, own-message edits and resolution become drafts, survive restart and can be revised or discarded', async () => {
  const r = await fixture();
  try {
    const record = await r.read();
    record.localEdits = [{ id: 'edit-1', action: 'editMessage', messageId: 'message-1', text: 'Edited message' }, { id: 'reply-1', action: 'reply', text: 'A multiline\nreply with β and Markdown **text**.' }, { id: 'resolve-1', action: 'resolve' }];
    await r.write(record); assert(await r.files.sync());
    assert.deepEqual((await r.state.read()).pending.map(d => d.kind), ['editMessage', 'reply', 'resolve']);
    const restarted = new LocalReviewFiles(new ProjectStore(r.root, r.state.baseUrl, 'test', ['main.tex']));
    assert.equal(await restarted.sync(), false); assert.equal((await r.state.read()).pending.length, 3);
    const edited = await r.read(); edited.localEdits[1].text = 'Revised reply'; await r.write(edited); await restarted.sync();
    assert.equal((await r.state.read()).pending[1].text, 'Revised reply');
    const cleared = await r.read(); cleared.localEdits = []; await r.write(cleared); await restarted.sync();
    assert.deepEqual((await r.state.read()).pending, []);
  } finally { await r.close(); }
});

test('malformed files, metadata edits, duplicate IDs and edits of collaborator messages are preserved and rejected atomically', async () => {
  const r = await fixture();
  try {
    const first = await r.read(), second = await r.read('thread-2');
    first.localEdits = [{ id: 'one', action: 'reply', text: 'Must not partially import' }]; await r.write(first);
    await writeFile(await r.path('thread-2'), '{'); await assert.rejects(r.files.sync(), /restore valid JSON/); assert.deepEqual((await r.state.read()).pending, []);
    assert.equal(await readFile(await r.path('thread-2'), 'utf8'), '{');
    second.localEdits = [{ id: 'one', action: 'reply', text: 'Duplicate ID' }]; await r.write(second);
    await assert.rejects(r.files.sync(), /already used/); assert.deepEqual((await r.state.read()).pending, []);
    second.localEdits = [{ id: 'own-only', action: 'editMessage', messageId: 'message-2', text: 'Cannot overwrite another author' }]; await r.write(second);
    await assert.rejects(r.files.sync(), /only your own/); assert.deepEqual((await r.state.read()).pending, []);
    second.localEdits = []; second.remote.thread!.messages[0].text = 'Changed snapshot'; await r.write(second);
    await assert.rejects(r.files.sync(), /only localEdits/);
  } finally { await r.close(); }
});

test('sent drafts cannot be replayed by a restart or an older JSON copy', async () => {
  const r = await fixture();
  try {
    const record = await r.read(); record.localEdits = [{ id: 'reply-1', action: 'reply', text: 'Send once' }]; await r.write(record);
    await r.files.importEdits(); // Simulate a crash before the generated files were refreshed.
    assert.equal(await new LocalReviewFiles(r.state).importEdits(), false);
    await r.state.update(data => { data.pending = []; }); // Simulate a verified send before export.
    assert.equal(await new LocalReviewFiles(r.state).importEdits(), false);
    assert.deepEqual((await r.state.read()).pending, []);
    await r.files.sync(); assert.deepEqual((await r.read()).localEdits, []);
    await r.write(record); await assert.rejects(r.files.sync(), /older copy/);
    assert.deepEqual((await r.state.read()).pending, []);
  } finally { await r.close(); }
});

test('concurrent panel edits and uncertain outcomes never get overwritten by JSON edits', async () => {
  const r = await fixture();
  try {
    const record = await r.read(); record.localEdits = [{ id: 'reply-1', action: 'reply', text: 'File reply' }]; await r.write(record);
    await r.state.queue({ id: 'panel-reply', kind: 'reply', threadId: 'thread-1', path: 'main.tex', docId: 'doc', text: 'Panel reply', before: r.inspection.threads['thread-1'], created: 'now' });
    await assert.rejects(r.files.sync(), /changed in the editor/);
    assert.equal((await r.state.read()).pending[0].text, 'Panel reply');
    await r.state.update(data => { data.pending = []; data.partialSend = { history: 'uncertain', confirmed: [], uncertain: ['comment:reply-1'] }; });
    await assert.rejects(r.files.sync(), /interrupted sync/);
    assert.deepEqual((await r.state.read()).pending, []);
  } finally { await r.close(); }
});

test('removed files regenerate without deleting comments, and symlinks cannot redirect review writes', async () => {
  const r = await fixture();
  try {
    await unlink(await r.path()); await r.files.sync(); assert.equal((await r.read()).threadId, 'thread-1');
    assert.deepEqual((await r.state.read()).pending, []);
    const target = join(r.root, 'keep.txt'); await writeFile(target, 'Keep this text'); await unlink(await r.path()); await symlink(target, await r.path());
    await assert.rejects(r.files.sync(), /symbolic link/); assert.equal(await readFile(target, 'utf8'), 'Keep this text');
  } finally { await r.close(); }
});

test('incoming-only threads remain readable and anchored but require Apply before drafting', async () => {
  const r = await fixture();
  try {
    await r.state.update(data => { delete data.acknowledged; }); await r.files.sync();
    const record = await r.read(); assert.equal(record.baseline.thread, null); assert.equal(record.remote.anchor?.line, 2);
    record.localEdits = [{ id: 'early', action: 'reply', text: 'Too soon' }]; await r.write(record);
    await assert.rejects(r.files.sync(), /Apply incoming/); assert.deepEqual((await r.state.read()).pending, []);
  } finally { await r.close(); }
});

test('removed anchors remain indexed without inventing a usable source line', async () => {
  const r = await fixture();
  try {
    await r.state.update(data => {
      for (const inspection of [data.acknowledged!, data.observed!]) {
        inspection.docs[0].comments[0] = { threadId: 'thread-1', state: 'anchor removed', ranges: [{ pos: 12, length: 0 }] };
      }
    });
    await r.files.sync();
    const record = await r.read(), index = JSON.parse(await readFile(await r.files.path('index.json'), 'utf8'));
    assert.equal(record.baseline.anchor?.line, null);
    assert.equal(index.threads[0].anchorState, 'anchor removed'); assert.equal(index.threads[0].baselineLine, null);
    const overview = await readFile(await r.files.path(), 'utf8');
    assert.match(overview, /main.tex:\?/); assert.match(overview, /Text deleted/); assert.doesNotMatch(overview, /anchor removed/);
    const headings = overview.split('\n').filter(line => /^#+ /.test(line));
    assert.equal(new Set(headings).size, headings.length, 'Generated Markdown has no duplicate heading diagnostics');
  } finally { await r.close(); }
});

test('explicit JSON revisions reconcile against the accepted message while unchanged drafts retain their original fence', async () => {
  const r = await fixture();
  try {
    const record = await r.read(); record.localEdits = [{ id: 'edit-1', action: 'editMessage', messageId: 'message-1', text: 'Original local revision' }];
    await r.write(record); await r.files.sync();
    await r.state.update(data => { data.acknowledged!.threads['thread-1'].messages[0].text = 'New remote revision'; data.observed = structuredClone(data.acknowledged); });
    await r.files.sync();
    assert.equal((await r.state.read()).pending[0].before?.messages[0].text, 'Original message', 'A refresh does not silently accept remote changes for an existing draft');
    const reconciled = await r.read(); reconciled.localEdits[0].text = 'Reconciled local revision'; await r.write(reconciled); await r.files.sync();
    assert.equal((await r.state.read()).pending[0].before?.messages[0].text, 'New remote revision');
  } finally { await r.close(); }
});

const request = (r: Awaited<ReturnType<typeof fixture>>, name: string, value: unknown) => r.files.path(`new/${name}`).then(path => writeFile(path, JSON.stringify(value)));
const exists = (path: string) => readFile(path).then(() => true, () => false);

test('a new-comment file queues an anchored thread on the quoted saved text and is removed once queued', async () => {
  const r = await fixture();
  try {
    const source = 'First line.\nSelected text.\n';
    await writeFile(join(r.root, 'main.tex'), source);
    assert.equal(await exists(await r.files.path('new-comment.schema.json')), true);
    assert.deepEqual(JSON.parse(await readFile(await r.files.path('index.json'), 'utf8')).newComments, { folder: 'new/', schema: 'new-comment.schema.json' });
    await request(r, 'c1.json', { $schema: '../new-comment.schema.json', id: 'agent-c1', path: 'main.tex', quote: 'Selected', text: 'Please justify.' });
    assert.equal(await r.files.sync(), true);
    const [draft] = (await r.state.read()).pending;
    assert.equal(draft.kind, 'createThread'); assert.equal(draft.id, 'agent-c1'); assert.equal(draft.docId, 'doc'); assert.equal(draft.text, 'Please justify.');
    assert.deepEqual(draft.anchor, { from: 12, to: 20, source });
    assert.match(draft.threadId, /^[0-9a-f]{24}$/);
    assert.equal(await exists(await r.files.path('new/c1.json')), false);
    const record = await r.read(draft.threadId);
    assert.equal(record.localSelection?.quotedText, 'Selected'); assert.equal(record.localSelection?.line, 2);
    assert.deepEqual(record.localEdits, [{ id: 'agent-c1', action: 'createThread', text: 'Please justify.' }]);
    // The exported thread accepts replies and text revisions like a panel-created one.
    record.localEdits = [{ id: 'agent-c1', action: 'createThread', text: 'Please justify this.' }, { id: 'agent-c1-r', action: 'reply', text: 'See Smith (2020).' }];
    await r.write(record); await r.files.sync();
    assert.deepEqual((await r.state.read()).pending.map(d => [d.kind, d.text, d.threadId]), [['createThread', 'Please justify this.', draft.threadId], ['reply', 'See Smith (2020).', draft.threadId]]);
    assert.equal(await r.files.sync(), false, 'A refresh does not queue the comment twice');
    assert.equal((await r.state.read()).pending.length, 2);
  } finally { await r.close(); }
});

test('ambiguous, missing or misplaced quotes and invalid targets are refused with the file kept and the reason written', async () => {
  const r = await fixture();
  try {
    await writeFile(join(r.root, 'main.tex'), 'line one\nline two\nline three\n');
    const path = await r.files.path('new/c.json'), refuse = async (value: unknown, pattern: RegExp) => {
      await request(r, 'c.json', value);
      await assert.rejects(r.files.sync(), pattern);
      assert.deepEqual((await r.state.read()).pending, []); assert.equal(await exists(path), true);
      assert.match(await readFile(await r.files.path('import-error.txt'), 'utf8'), pattern);
    };
    const base = { id: 'c', path: 'main.tex', text: 'Note' };
    await refuse({ ...base, quote: 'line' }, /occurs 3 times in main.tex \(lines 1, 2, 3\)/);
    await refuse({ ...base, quote: 'missing' }, /was not found/);
    await refuse({ ...base, quote: 'line', line: 5 }, /does not start on line 5/);
    await refuse({ ...base, quote: 'line', occurrence: 4 }, /occurrence 4 does not exist/);
    await refuse({ ...base, quote: 'line', occurrence: 1, line: 1 }, /not both/);
    await refuse({ ...base, quote: 'line one', extra: true }, /use only the fields/);
    await refuse({ ...base, quote: 'line one', path: 'other.tex' }, /not a selected source file/);
    await refuse({ ...base, quote: 'line one', id: 'bad id' }, /id needs/);
    await refuse({ ...base, quote: 'line one', text: ' ' }, /text needs/);
    await r.state.update(data => { data.acknowledged!.docs = []; });
    await refuse({ ...base, quote: 'line one' }, /not on Overleaf/);
    await r.state.update(data => { data.acknowledged = structuredClone(r.inspection); });
    await request(r, 'c.json', { ...base, quote: 'line', line: 3 });
    await r.files.sync();
    assert.equal(await exists(await r.files.path('import-error.txt')), false, 'A successful import clears the reason');
    assert.deepEqual((await r.state.read()).pending[0].anchor?.from, 18);
  } finally { await r.close(); }
});

test('reusing a new comment id moves it after a source edit; other ids, duplicates and interrupted syncs are refused', async () => {
  const r = await fixture();
  try {
    await writeFile(join(r.root, 'main.tex'), 'Alpha beta.\n');
    await request(r, 'a.json', { id: 'move-me', path: 'main.tex', quote: 'beta', text: 'First' });
    await r.files.sync();
    const [first] = (await r.state.read()).pending;
    await writeFile(join(r.root, 'main.tex'), 'Intro.\nAlpha beta.\n');
    await request(r, 'b.json', { id: 'move-me', path: 'main.tex', quote: 'beta', text: 'First' });
    assert.equal(await r.files.sync(), true);
    const [moved] = (await r.state.read()).pending;
    assert.equal(moved.threadId, first.threadId); assert.equal(moved.created, first.created);
    assert.deepEqual(moved.anchor, { from: 13, to: 17, source: 'Intro.\nAlpha beta.\n' });
    // Replaying an already queued request (a crash before its removal) changes nothing.
    await request(r, 'b.json', { id: 'move-me', path: 'main.tex', quote: 'beta', text: 'First' });
    assert.equal(await r.files.sync(), false); assert.equal((await r.state.read()).pending.length, 1);
    await request(r, 'c.json', { id: 'one', path: 'main.tex', quote: 'Alpha', text: 'x' }); await request(r, 'd.json', { id: 'one', path: 'main.tex', quote: 'Intro', text: 'y' });
    await assert.rejects(r.files.sync(), /used by another file/);
    await unlink(await r.files.path('new/d.json')); await unlink(await r.files.path('new/c.json'));
    const record = await r.read(); record.localEdits = [{ id: 'reply-1', action: 'reply', text: 'Reply' }]; await r.write(record); await r.files.sync();
    await request(r, 'e.json', { id: 'reply-1', path: 'main.tex', quote: 'Alpha', text: 'x' });
    await assert.rejects(r.files.sync(), /already used/);
    await unlink(await r.files.path('new/e.json'));
    await r.state.update(data => { data.partialSend = { history: 'uncertain', confirmed: [], uncertain: [] }; });
    await request(r, 'f.json', { id: 'later', path: 'main.tex', quote: 'Alpha', text: 'x' });
    await assert.rejects(r.files.sync(), /interrupted sync/);
    assert.equal((await r.state.read()).pending.some(d => d.id === 'later'), false);
  } finally { await r.close(); }
});

test('links in new/ are refused without reading or removing their target', async () => {
  const r = await fixture();
  try {
    const target = join(r.root, 'keep.json'); await writeFile(target, '{}');
    await symlink(target, await r.files.path('new/link.json'));
    await assert.rejects(r.files.sync(), /regular JSON file/);
    assert.equal(await readFile(target, 'utf8'), '{}');
  } finally { await r.close(); }
});

test('moveSelection follows edits, a cut-and-paste of unique text, and refuses changed or ambiguous text', () => {
  const source = 'Alpha. Beta gamma. Delta.\n', anchor = { from: 7, to: 17, source };
  assert.deepEqual(moveSelection(anchor, 'New. ' + source), { from: 12, to: 22, source: 'New. ' + source });
  const pasted = 'Delta.\nAlpha. Beta gamma. \n';
  assert.deepEqual(moveSelection(anchor, pasted)?.from, pasted.indexOf('Beta gamma'));
  assert.equal(moveSelection(anchor, source.replace('gamma', 'GAMMA')), undefined);
  const repeated = { from: 0, to: 3, source: 'abc abc\n' };
  assert.deepEqual(moveSelection(repeated, 'x abc abc\n'), { from: 2, to: 5, source: 'x abc abc\n' });
  assert.equal(moveSelection(repeated, 'abX abc\n'), undefined, 'Text not unique before is not looked for elsewhere');
});

test('followSelections moves new comments with their saved text and lists the ones needing a new selection', async () => {
  const r = await fixture();
  try {
    const source = 'First line.\nSelected text.\n', make = (id: string, from: number, to: number) => ({ id, kind: 'createThread' as const, path: 'main.tex', docId: 'doc', threadId: `t-${id}`, text: 'x', anchor: { from, to, source }, created: 'now' });
    await r.state.queue(make('keeps', 12, 20)); await r.state.queue(make('edited', 0, 5));
    assert.deepEqual(await r.state.followSelections({ 'main.tex': source }), { moved: [], unplaced: [] });
    const saved = { 'main.tex': 'Intro.\nFIRST line.\nSelected text.\n' };
    assert.deepEqual(await r.state.followSelections(saved), { moved: ['keeps'], unplaced: ['edited'] });
    const [keeps, edited] = (await r.state.read()).pending;
    assert.deepEqual(keeps.anchor, { from: 19, to: 27, source: saved['main.tex'] }); assert.equal(edited.anchor?.source, source);
    await r.state.update(data => { data.partialSend = { history: 'h', confirmed: [], uncertain: [] }; });
    assert.deepEqual(await r.state.followSelections({ 'main.tex': 'Other.\n' + saved['main.tex'] }), { moved: [], unplaced: ['keeps', 'edited'] });
  } finally { await r.close(); }
});

test('a moved new comment keeps its thread file editable without a refresh in between', async () => {
  const r = await fixture();
  try {
    const source = 'First line.\nSelected text.\n';
    await writeFile(join(r.root, 'main.tex'), source);
    await request(r, 'c.json', { id: 'agent-c', path: 'main.tex', quote: 'Selected', text: 'Comment' });
    await r.files.sync();
    const threadId = (await r.state.read()).pending[0].threadId, record = await r.read(threadId);
    await r.state.followSelections({ 'main.tex': 'New first.\n' + source });
    record.localEdits.push({ id: 'agent-c-reply', action: 'reply', text: 'Reply' }); await r.write(record);
    await r.files.sync();
    const pending = (await r.state.read()).pending;
    assert.deepEqual(pending.map(d => d.kind), ['createThread', 'reply']);
    assert.equal(pending[0].anchor?.from, 'New first.\n'.length + 12, 'The import keeps the moved selection');
  } finally { await r.close(); }
});
