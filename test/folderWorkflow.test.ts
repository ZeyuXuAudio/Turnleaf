import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ProjectStore, CommentDraft, SentText } from '../src/core/projectStore';
import { ReviewWorkflow, SyncService, remoteTexts, projectedInspection, planDifferences, irreversible } from '../src/core/folderWorkflow';
import { OverleafReader } from '../src/core/overleaf';
import { readSaved } from '../src/core/savedFiles';
import { commentAttachment } from '../src/core/commentAttachment';
import { LocalReviewFiles, ThreadFile } from '../src/core/reviewFiles';
import { fixtureCookie, startFixtureServer } from './fixtureServer';

async function linked(initial = true, trackChanges = true) {
  const fixture = await startFixtureServer({ writable: true, trackChanges }), root = await mkdtemp(join(tmpdir(), 'overleaf-folder-'));
  fixture.replies.modern[0] = { content: 'Rain was excluded.\n\nMethods.\n\nResults.\n\nDrift: 0.64.\n', comments: [{ id: 'c1', ranges: [{ pos: 0, length: 4 }] }], trackedChanges: [] };
  const reader = new OverleafReader(fixture.baseUrl, fixtureCookie), paths = ['main.tex', 'references.bib'];
  const inspection = await reader.inspect('test-project', paths);
  for (const [path, text] of Object.entries(remoteTexts(inspection))) await writeFile(join(root, path), text);
  const state = new ProjectStore(root, fixture.baseUrl, 'test-project', paths), sync = new SyncService(state, reader), workflow = new ReviewWorkflow(sync);
  if (initial) await workflow.apply(await workflow.preparePull(), () => true);
  return { root, fixture, reader, paths, state, sync, workflow, inspection,
    local: () => readSaved(root, paths, true),
    draft(kind: CommentDraft['kind'], fields: Partial<CommentDraft> = {}): CommentDraft { return { id: randomUUID(), kind, path: 'main.tex', docId: 'modern', threadId: 'c1', before: structuredClone(inspection.threads.c1), created: new Date().toISOString(), ...fields }; },
    remoteEdit(text: string) { fixture.replies.modern[0].content = text; fixture.replies.modern[1]++; },
    close: async () => { await fixture.close(); await rm(root, { recursive: true, force: true }); } };
}

test('an ordinary folder previews and sends saved files without creating Git metadata', async () => {
  const r = await linked(); const originalPath = process.env.PATH;
  try {
    process.env.PATH = '/nonexistent-no-git';
    await writeFile(join(r.root, 'notes.txt'), 'Unrelated work');
    await writeFile(join(r.root, 'main.tex'), r.inspection.docs[0].text + 'Local addition.\n');
    const plan = await r.workflow.prepareSend(); assert.equal(plan.files.length, 1);
    const result = await r.sync.push(plan, () => true, () => {});
    assert.match(result.inspection.docs[0].text, /Local addition/);
    assert.equal((await r.workflow.prepareSend()).files.length, 0);
    await assert.rejects(access(join(r.root, '.git')));
    assert.equal(await readFile(join(r.root, 'notes.txt'), 'utf8'), 'Unrelated work');
    const history = await r.state.history(); assert.equal(history[0].outcome, 'success');
    assert.equal(history[0].files[0].after, plan.files[0].text); assert.equal(history[0].files[0].before, plan.files[0].doc.text);
  } finally { process.env.PATH = originalPath; await r.close(); }
});

test('unknown initial baseline requires an explicit resolution when files differ', async () => {
  const r = await linked(false);
  try {
    await writeFile(join(r.root, 'main.tex'), 'Existing local work.\n');
    const plan = await r.workflow.preparePull(); assert(plan.files[0].conflict);
    assert.equal((await r.state.read()).acknowledged, undefined);
    await assert.rejects(r.workflow.apply(plan, () => true), /Resolve every/);
    const chosen = r.workflow.resolve(plan, 'main.tex', 'Existing local work.\n');
    await r.workflow.apply(chosen, () => true);
    assert.equal((await r.local())['main.tex'], 'Existing local work.\n');
    assert.equal((await r.workflow.prepareSend()).files[0].text, 'Existing local work.\n');
  } finally { await r.close(); }
});

test('using the Overleaf version applies once and leaves Get latest and Send empty', async () => {
  const r = await linked(false);
  try {
    const local = 'Existing local work.\n';
    await writeFile(join(r.root, 'main.tex'), local);
    const preview = await r.workflow.preparePull();
    const file = preview.files.find(file => file.path === 'main.tex')!;
    assert(file.conflict && file.firstSync);
    const chosen = r.workflow.resolve(preview, file.path, file.remote);
    assert.equal((await r.local())['main.tex'], local, 'Choosing a version does not apply it');
    assert.equal((await r.state.read()).acknowledged, undefined);

    const applied = await r.workflow.apply(chosen, () => true);
    assert.deepEqual(await r.local(), remoteTexts(chosen.inspection));
    const data = await r.state.read();
    assert.equal(data.revision, applied.snapshot);
    assert.equal(data.localApply, undefined);
    const [history] = await r.state.history(applied.checkpoint);
    assert.equal(history.outcome, 'success');
    assert.deepEqual(history.warnings, []);
    assert.equal(history.files[0].before, local, 'The replaced local text remains recoverable');
    assert.equal(history.files[0].after, file.remote);

    const latest = await r.workflow.preparePull(), send = await r.workflow.prepareSend();
    assert.deepEqual(latest.files, []);
    assert.deepEqual(latest.comments, []);
    assert.deepEqual(send.files, []);
    assert.deepEqual(send.comments, []);
  } finally { await r.close(); }
});

test('a rejected first Apply retains the local difference for the next Get latest', async () => {
  const r = await linked(false);
  try {
    const local = 'Existing local work.\n';
    await writeFile(join(r.root, 'main.tex'), local);
    const preview = await r.workflow.preparePull();
    const chosen = r.workflow.resolve(preview, 'main.tex', preview.files[0].remote);
    r.remoteEdit(r.inspection.docs[0].text + 'New remote edit during review.\n');
    await assert.rejects(r.workflow.apply(chosen, () => true), /Overleaf changed during review/);
    assert.equal((await r.local())['main.tex'], local);
    const data = await r.state.read();
    assert.equal(data.acknowledged, undefined);
    assert.equal(data.revision, undefined);
    assert.equal(data.localApply, undefined);

    const latest = await r.workflow.preparePull();
    const file = latest.files.find(file => file.path === 'main.tex')!;
    assert(file.conflict && file.firstSync, 'The failed Apply must not hide the remaining difference');
    assert.equal(file.before, local);
    assert.match(file.remote, /New remote edit during review/);
  } finally { await r.close(); }
});

test('polling and incoming preview do not acknowledge comment or file changes', async () => {
  const r = await linked();
  try {
    const before = await r.state.read(), local = await r.local();
    r.fixture.threads.c1.messages.push({ id: 'remote-reply', user: { id: 'other', name: 'Collaborator' }, content: 'Remote comment' });
    r.remoteEdit(r.inspection.docs[0].text.replace('0.64', '0.62'));
    await r.sync.refresh(); const plan = await r.workflow.preparePull();
    assert.equal(plan.comments.length, 1); assert.equal(plan.comments[0].after?.messages.length, 2);
    assert.equal(plan.files.length, 1); assert.deepEqual(await r.local(), local);
    assert.deepEqual((await r.state.read()).acknowledged, before.acknowledged);
    await r.workflow.apply(plan, () => true);
    assert.equal((await r.state.read()).acknowledged?.threads.c1.messages.length, 2);
    assert.match((await r.local())['main.tex']!, /0.62/);
  } finally { await r.close(); }
});

test('queued edits, replies and resolve share a comment-only review and send in order', async () => {
  const r = await linked();
  try {
    await r.state.queue(r.draft('editMessage', { messageId: 'c1-m1', text: 'Edited locally' }));
    await r.state.queue(r.draft('reply', { text: 'Local reply' }));
    await r.state.queue(r.draft('resolve'));
    assert.equal(r.fixture.threads.c1.messages.length, 1);
    const restarted = new ProjectStore(r.root, r.fixture.baseUrl, 'test-project', r.paths);
    assert.equal((await restarted.read()).pending.length, 3);
    assert.equal(projectedInspection(await restarted.read())?.threads.c1.messages[0].text, 'Edited locally');
    const plan = await r.workflow.prepareSend(); assert.equal(plan.files.length, 0); assert.equal(plan.comments.length, 3);
    assert.equal(plan.comments[0].before?.messages[0].text, r.inspection.threads.c1.messages[0].text);
    assert.equal(plan.comments[0].after?.messages[0].text, 'Edited locally');
    await r.sync.push(plan, () => true, () => {});
    assert.equal(r.fixture.threads.c1.messages[0].content, 'Edited locally');
    assert.equal(r.fixture.threads.c1.messages[1].content, 'Local reply'); assert(r.fixture.threads.c1.resolved);
    assert.equal((await r.state.read()).pending.length, 0);
    assert.equal((await r.state.history())[0].completed.length, 3);
  } finally { await r.close(); }
});

test('saved comment JSON is reviewed and sent once, and later JSON changes invalidate an open send', async () => {
  const r = await linked();
  try {
    const files = new LocalReviewFiles(r.state); await files.enable();
    const path = await files.path('threads/c1.json');
    const record: ThreadFile = JSON.parse(await readFile(path, 'utf8'));
    record.localEdits = [{ id: 'json-edit', action: 'editMessage', messageId: 'c1-m1', text: 'Edited through JSON' }, { id: 'json-reply', action: 'reply', text: 'Reply from a local JSON file' }];
    await writeFile(path, JSON.stringify(record));
    const plan = await r.workflow.prepareSend();
    assert.equal(plan.files.length, 0); assert.equal(plan.comments.length, 2);
    assert.equal(r.fixture.threads.c1.messages.length, 1, 'Preparing a review must not send JSON drafts');
    const updated: ThreadFile = JSON.parse(await readFile(path, 'utf8'));
    updated.localEdits[1].text = 'Revised after opening the review'; await writeFile(path, JSON.stringify(updated));
    await assert.rejects(r.sync.push(plan, () => true, () => {}), /drafts.*changed/);
    assert.equal(r.fixture.threads.c1.messages.length, 1, 'Stale JSON review must not publish any comment');
    const next = await r.workflow.prepareSend();
    await r.sync.push(next, () => true, () => {});
    assert.equal(r.fixture.threads.c1.messages[0].content, 'Edited through JSON');
    assert.equal(r.fixture.threads.c1.messages.at(-1).content, 'Revised after opening the review');
    await files.sync(); assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).localEdits, []);
    assert.equal((await r.workflow.prepareSend()).comments.length, 0, 'A completed send must not recreate old JSON drafts');
  } finally { await r.close(); }
});

test('file changes and selection-bound new comments send in one review, with an anchored reply', async () => {
  const r = await linked();
  try {
    const source = r.inspection.docs[0].text + 'New selected paragraph.\n';
    await writeFile(join(r.root, 'main.tex'), source);
    const draft = r.draft('createThread', { threadId: 'new-local-thread', text: 'Discuss the new paragraph', before: undefined, anchor: { from: source.indexOf('New selected'), to: source.length - 1, source } });
    await r.state.queue(draft); await r.state.queue(r.draft('reply', { threadId: draft.threadId, before: undefined, text: 'Follow-up' }));
    const plan = await r.workflow.prepareSend(); assert.equal(plan.comments.length, 2); assert.equal(plan.files.length, 1);
    const sent = await r.sync.push(plan, () => true, () => {}), doc = sent.inspection.docs[0];
    const anchor = doc.comments.find(c => c.threadId === draft.threadId)!;
    assert.equal(doc.text.slice(anchor.ranges[0].pos, anchor.ranges[0].pos + anchor.ranges[0].length), 'New selected paragraph.');
    assert.equal(sent.inspection.threads[draft.threadId].messages.length, 2);
  } finally { await r.close(); }
});

test('a new comment requested by a JSON file in new/ is reviewed with a source edit and sent on the quoted text', async () => {
  const r = await linked();
  try {
    const files = new LocalReviewFiles(r.state); await files.enable();
    const source = r.inspection.docs[0].text + 'Agent paragraph.\n';
    await writeFile(join(r.root, 'main.tex'), source);
    await writeFile(await files.path('new/c.json'), JSON.stringify({ id: 'agent-new', path: 'main.tex', quote: 'Agent paragraph.', text: 'Comment from a file' }));
    const plan = await r.workflow.prepareSend();
    assert.equal(plan.files.length, 1); assert.deepEqual(plan.comments.map(c => c.label), ['New comment']);
    await assert.rejects(access(await files.path('new/c.json')));
    const sent = await r.sync.push(plan, () => true, () => {}), doc = sent.inspection.docs[0];
    const anchor = doc.comments.find(c => sent.inspection.threads[c.threadId]?.messages[0]?.text === 'Comment from a file')!;
    assert.equal(doc.text.slice(anchor.ranges[0].pos, anchor.ranges[0].pos + anchor.ranges[0].length), 'Agent paragraph.');
  } finally { await r.close(); }
});

test('new legacy comments preserve Unicode and use the actual selected range', async () => {
  const r = await linked();
  try {
    const doc = r.inspection.docs[1];
    await r.state.queue(r.draft('createThread', { path: doc.path, docId: doc.docId, threadId: 'legacy-new', text: 'Unicode selection', before: undefined, anchor: { from: 0, to: 4, source: doc.text } }));
    const result = await r.sync.push(await r.workflow.prepareSend(), () => true, () => {});
    assert.equal(result.inspection.docs[1].comments.find(c => c.threadId === 'legacy-new')?.ranges[0].length, 4);
    const packet = r.fixture.requests.find(r => r.packet?.includes('applyOtUpdate'))!.packet!;
    assert(packet.includes('Jörg'));
  } finally { await r.close(); }
});

test('new comment attachment splits visible selections around hidden deletions', async () => {
  const r = await linked();
  try {
    const doc = { ...r.inspection.docs[0], text: 'Alpha βeta.', rawContent: 'Alpha old βeta.', rawChanges: [{ range: { pos: 6, length: 4 }, tracking: { type: 'delete' as const, userId: 'other' } }] };
    assert.deepEqual(commentAttachment(doc, 'new', 0, doc.text.length), { commentId: 'new', ranges: [{ pos: 0, length: 6 }, { pos: 10, length: 5 }] });
    assert.throws(() => commentAttachment(doc, 'new', 2, 2), /non-empty/);
  } finally { await r.close(); }
});

test('same-position edits conflict; disjoint local and remote edits survive pull and send', async () => {
  const r = await linked();
  try {
    const base = r.inspection.docs[0].text;
    await writeFile(join(r.root, 'main.tex'), base.replace('Rain was excluded.', 'Rain was excluded using the gauge.'));
    r.remoteEdit(base.replace('0.64', '0.62'));
    const plan = await r.workflow.preparePull(); assert(!plan.files[0].conflict); assert.match(plan.files[0].after, /gauge/); assert.match(plan.files[0].after, /0.62/);
    await r.workflow.apply(plan, () => true); await r.sync.push(await r.workflow.prepareSend(), () => true, () => {});
    const shared = r.fixture.replies.modern[0].content;
    await writeFile(join(r.root, 'main.tex'), shared.replace('0.62', '0.60')); r.remoteEdit(shared.replace('0.62', '0.58'));
    assert((await r.workflow.preparePull()).files[0].conflict);
  } finally { await r.close(); }
});

test('saved edits, dirty buffers, queued draft edits and remote comments each invalidate Send', async () => {
  const r = await linked();
  try {
    await r.state.queue(r.draft('reply', { text: 'Pending' })); let plan = await r.workflow.prepareSend();
    await assert.rejects(r.sync.push(plan, () => false, () => {}), /Saved files, comment drafts/);
    const draft = (await r.state.read()).pending[0]; await r.state.queue({ ...draft, text: 'Revised' });
    await assert.rejects(r.sync.push(plan, () => true, () => {}), /Saved files, comment drafts/);
    plan = await r.workflow.prepareSend(); await writeFile(join(r.root, 'main.tex'), r.inspection.docs[0].text + 'unsent');
    await assert.rejects(r.sync.push(plan, () => true, () => {}), /Saved files, comment drafts/);
    plan = await r.workflow.prepareSend(); r.fixture.threads.c1.messages[0].content = 'Remote edit';
    await assert.rejects(r.sync.push(plan, () => true, () => {}), /Overleaf changed/);
    assert.equal(r.fixture.requests.filter(request => request.path.endsWith('/upload') || request.path.endsWith('/messages')).length, 0);
  } finally { await r.close(); }
});

test('new selection drafts refuse an edited selected text and can be discarded with dependent replies', async () => {
  const r = await linked();
  try {
    const source = r.inspection.docs[0].text + 'Selected words here.\n', from = source.indexOf('Selected words');
    await writeFile(join(r.root, 'main.tex'), source);
    const draft = r.draft('createThread', { threadId: 'new', text: 'Selection', anchor: { from, to: from + 14, source } });
    await r.state.queue(draft); await r.state.queue(r.draft('reply', { threadId: 'new', text: 'Dependent reply' }));
    await writeFile(join(r.root, 'main.tex'), source.replace('Selected words', 'Chosen words'));
    await assert.rejects(r.workflow.prepareSend(), /text a new comment was on changed in main.tex/);
    await r.state.discard(draft.id); assert.equal((await r.state.read()).pending.length, 0);
  } finally { await r.close(); }
});

test('new comments follow their selected text through saved edits and are sent there', async () => {
  const r = await linked();
  try {
    const source = r.inspection.docs[0].text + 'Selected words here.\n', from = source.indexOf('Selected words');
    await writeFile(join(r.root, 'main.tex'), source);
    const draft = r.draft('createThread', { threadId: 'follow', text: 'Follows its text', before: undefined, anchor: { from, to: from + 14, source } });
    await r.state.queue(draft);
    const edited = 'An inserted first line.\n' + source.replace('here.', 'here, and more.');
    await writeFile(join(r.root, 'main.tex'), edited);
    const sent = await r.sync.push(await r.workflow.prepareSend(), () => true, () => {}), doc = sent.inspection.docs[0];
    const anchor = doc.comments.find(c => c.threadId === 'follow')!;
    assert.equal(doc.text.slice(anchor.ranges[0].pos, anchor.ranges[0].pos + anchor.ranges[0].length), 'Selected words');
  } finally { await r.close(); }
});

test('partial new-thread creation is journaled and never silently duplicated on retry', async () => {
  const r = await linked();
  try {
    const draft = r.draft('createThread', { threadId: 'partial-thread', text: 'Retained message', before: undefined, anchor: { from: 0, to: 4, source: r.inspection.docs[0].text } });
    await r.state.queue(draft); r.fixture.failAnchor(true);
    await assert.rejects(r.sync.push(await r.workflow.prepareSend(), () => true, () => {}));
    assert.equal(r.fixture.threads[draft.threadId].messages.length, 1);
    assert.equal((await r.state.history())[0].outcome, 'uncertain');
    await assert.rejects(r.workflow.prepareSend(), /interrupted send/);
    r.fixture.failAnchor(false); await r.workflow.apply(await r.workflow.preparePull(), () => true);
    await assert.rejects(r.workflow.prepareSend(), /uncertain earlier outcome/);
    assert.equal(r.fixture.threads[draft.threadId].messages.length, 1); await r.state.discard(draft.id);
  } finally { await r.close(); }
});

test('incoming preview refuses remote changes and preserves local edits on interrupted Apply recovery', async () => {
  const r = await linked();
  try {
    r.remoteEdit(r.inspection.docs[0].text + 'Incoming\n'); const plan = await r.workflow.preparePull(), before = await r.local();
    r.fixture.threads.c1.messages[0].content = 'Changed while reviewing';
    await assert.rejects(r.workflow.apply(plan, () => true), /Overleaf changed/); assert.deepEqual(await r.local(), before);
    const fresh = await r.workflow.preparePull(); let checks = 0;
    await assert.rejects(r.workflow.apply(fresh, () => ++checks < 3), /Recover Local Apply/);
    assert((await r.state.read()).localApply); await r.workflow.recover(() => true); assert.deepEqual(await r.local(), before);
    assert.equal((await r.state.history())[0].outcome, 'recovered');
  } finally { await r.close(); }
});

test('an incoming comment-only update waits for Apply and retains an unsent local reply', async () => {
  const r = await linked();
  try {
    const draft = r.draft('reply', { text: 'Pending local reply' }); await r.state.queue(draft);
    r.fixture.threads.c1.messages.push({ id: 'remote', user: { id: 'other', name: 'Other' }, content: 'Incoming reply' });
    // Review & send now shows the incoming comment instead of refusing; nothing is acknowledged yet.
    const combined = await r.workflow.prepareSend();
    assert.equal(combined.incoming?.comments.length, 1); assert.equal(combined.files.length, 0); assert.equal(combined.comments.length, 1);
    const plan = await r.workflow.preparePull(); assert.equal(plan.files.length, 0); assert.equal(plan.comments.length, 1);
    assert.equal((await r.state.read()).acknowledged?.threads.c1.messages.length, 1);
    await r.workflow.apply(plan, () => true);
    assert.equal((await r.state.read()).pending[0].id, draft.id);
    await r.sync.push(await r.workflow.prepareSend(), () => true, () => {});
    assert.deepEqual(r.fixture.threads.c1.messages.map((m: any) => m.content), [r.inspection.threads.c1.messages[0].text, 'Incoming reply', 'Pending local reply']);
  } finally { await r.close(); }
});

test('a remote edit to a locally edited message requires revising or discarding the draft after Apply', async () => {
  const r = await linked();
  try {
    const draft = r.draft('editMessage', { messageId: 'c1-m1', text: 'Local edit' }); await r.state.queue(draft);
    r.fixture.threads.c1.messages[0].content = 'Remote edit';
    await r.workflow.apply(await r.workflow.preparePull(), () => true);
    await assert.rejects(r.workflow.prepareSend(), /remote message differs/);
    assert.equal((await r.state.read()).pending[0].text, 'Local edit');
    assert.equal(r.fixture.threads.c1.messages[0].content, 'Remote edit');
  } finally { await r.close(); }
});

test('local save during remote recheck prevents an upload', async () => {
  const r = await linked();
  try {
    const local = r.inspection.docs[0].text + 'First local version\n'; await writeFile(join(r.root, 'main.tex'), local);
    const plan = await r.workflow.prepareSend(), original = r.reader.openSession.bind(r.reader);
    r.reader.openSession = async (...args) => {
      const session = await original(...args), rejoin = session.rejoin;
      session.rejoin = async doc => { const fresh = await rejoin(doc); await writeFile(join(r.root, 'main.tex'), local + 'Newer local version\n'); return fresh; };
      return session;
    };
    await assert.rejects(r.sync.push(plan, () => true, () => {}), /Saved files, comment drafts/);
    assert.equal(r.fixture.requests.filter(request => request.path.endsWith('/upload')).length, 0);
    assert.match((await r.local())['main.tex']!, /Newer local version/);
  } finally { await r.close(); }
});

test('a comment that arrives during an upload is not silently acknowledged', async () => {
  const r = await linked();
  try {
    await writeFile(join(r.root, 'main.tex'), r.inspection.docs[0].text + 'Local revision\n');
    const plan = await r.workflow.prepareSend(), original = r.reader.write.bind(r.reader);
    r.reader.write = async (permit, live) => { await original(permit, live); r.fixture.threads.c1.messages.push({ id: 'simultaneous', user: { id: 'other', name: 'Other' }, content: 'Added during upload' }); };
    await assert.rejects(r.sync.push(plan, () => true, () => {}), /Comments changed during Send/);
    assert.equal((await r.state.read()).acknowledged?.threads.c1.messages.length, 1);
    const history = (await r.state.history())[0]; assert.equal(history.outcome, 'partial'); assert.equal(history.observed?.comments.c1.messages.length, 2);
    const incoming = await r.workflow.preparePull(); assert.equal(incoming.comments[0].after?.messages.length, 2);
    await r.workflow.apply(incoming, () => true); assert.equal((await r.state.read()).partialSend, undefined);
  } finally { await r.close(); }
});

test('an uncertain reply remains blocked even if a crash happened before its draft flag was persisted', async () => {
  const r = await linked();
  try {
    const draft = r.draft('reply', { text: 'Possibly sent' }); await r.state.queue(draft);
    await r.state.update(data => { data.partialSend = { history: 'simulated-crash', confirmed: [], uncertain: [`comment:${draft.id}`] }; });
    await r.workflow.apply(await r.workflow.preparePull(), () => true);
    assert((await r.state.read()).pending[0].uncertain);
    await assert.rejects(r.workflow.prepareSend(), /uncertain earlier outcome/);
    assert.equal(r.fixture.threads.c1.messages.length, 1);
  } finally { await r.close(); }
});

test('delete previews show the exact removed content before confirmed sending', async () => {
  const r = await linked();
  try {
    await r.state.queue(r.draft('deleteMessage', { messageId: 'c1-m1' }));
    const plan = await r.workflow.prepareSend(); assert.equal(plan.comments[0].before?.messages.length, 1); assert.equal(plan.comments[0].after?.messages.length, 0);
    assert.equal(r.fixture.threads.c1.messages.length, 1);
    await r.sync.push(plan, () => true, () => {}); assert.equal(r.fixture.threads.c1.messages.length, 0);
    await r.state.queue(r.draft('deleteThread', { before: (await r.state.read()).acknowledged!.threads.c1 }));
    const remove = await r.workflow.prepareSend(); assert.equal(remove.comments[0].after, undefined);
    await r.sync.push(remove, () => true, () => {}); assert.equal(r.fixture.threads.c1, undefined);
  } finally { await r.close(); }
});

test('the standing plan equals the fresh Send plan and asks Overleaf nothing; a change on Overleaf shows as differing rows', async () => {
  const r = await linked();
  try {
    const text = r.inspection.docs[0].text;
    await writeFile(join(r.root, 'main.tex'), text + 'Local addition.\n');
    const reply = r.draft('reply', { text: 'Local reply' }); await r.state.queue(reply);
    const data = await r.state.read(), requests = r.fixture.requests.length;
    const standing = await r.workflow.planSend(data, data.observed!, await r.local());
    assert.equal(r.fixture.requests.length, requests, 'The standing plan makes no request');
    assert(standing.plan); assert.deepEqual(standing.plan.files.map(file => [file.doc.path, file.added, file.removed]), [['main.tex', 1, 0]]);
    assert.deepEqual(standing.plan.comments.map(change => change.label), ['Reply']);
    assert.deepEqual(planDifferences(standing.plan, await r.workflow.prepareSend()), [], 'Nothing changed: the click may send');
    r.remoteEdit(text.replace('Rain', 'Snow'));
    const fresh = await r.workflow.prepareSend();
    // The commented word changed too, so the rows of that thread differ as well.
    assert.deepEqual(planDifferences(standing.plan, fresh).sort(), [`comment:${reply.id}`, 'file:main.tex', 'incoming-comment:c1', 'incoming:main.tex']);
    assert.equal(fresh.incoming?.files[0].after, text.replace('Rain', 'Snow') + 'Local addition.\n');
    await r.state.queue({ ...reply, text: 'Reworded reply' });
    const reworded = await r.state.read();
    assert.deepEqual(planDifferences(fresh, (await r.workflow.planSend(reworded, reworded.observed!, await r.local())).plan!), [`comment:${reply.id}`]);
  } finally { await r.close(); }
});

test('a blocked standing plan names the reason and the single way out', async () => {
  const r = await linked(), fresh = await linked(false);
  try {
    const text = r.inspection.docs[0].text, plan = async () => { const data = await r.state.read(); return r.workflow.planSend(data, data.observed!, await r.local()); };
    const first = await fresh.state.read();
    assert.deepEqual((await fresh.workflow.planSend(first, fresh.inspection, await fresh.local())).blocked, { way: 'getLatest', message: 'Get latest to establish the local sync baseline.', code: 'incoming' });
    const uncertain = r.draft('reply', { text: 'Sent or not?', uncertain: true }); await r.state.queue(uncertain);
    const draft = (await plan()).blocked; assert.equal(draft?.way, 'draft'); assert.equal(draft?.draftId, uncertain.id); assert.match(draft!.message, /uncertain earlier outcome/);
    await r.state.discard(uncertain.id);
    await writeFile(join(r.root, 'main.tex'), text.replace('Rain', 'Hail')); r.remoteEdit(text.replace('Rain', 'Snow')); await r.sync.refresh();
    const conflict = (await plan()).blocked; assert.equal(conflict?.way, 'getLatest'); assert.match(conflict!.message, /main\.tex \(near line 1\) also changed on Overleaf where you edited/);
    await rm(join(r.root, 'main.tex'));
    const missing = (await plan()).blocked; assert.equal(missing?.way, 'getLatest'); assert.match(missing!.message, /main\.tex is missing in the local folder/);
    await assert.rejects(r.workflow.prepareSend(), /missing in the local folder/);
    await writeFile(join(r.root, 'main.tex'), text);
    await r.state.update(data => { data.localApply = { history: 'h', before: {}, after: {} }; });
    assert.equal((await plan()).blocked?.way, 'recover');
  } finally { await r.close(); await fresh.close(); }
});

test('rows that Undo this send could not bring back are marked with the reason', async () => {
  const r = await linked();
  try {
    const reply = r.draft('reply', { text: 'Local reply' }), removal = r.draft('deleteMessage', { messageId: 'c1-m1' });
    await r.state.queue(reply); await r.state.queue(removal);
    // The comment c1 is on "Rain".
    await writeFile(join(r.root, 'main.tex'), r.inspection.docs[0].text.replace('Rain was', 'It was'));
    const marks = irreversible(await r.workflow.prepareSend());
    assert.deepEqual(Object.keys(marks).sort(), [`comment:${removal.id}`, 'file:main.tex'].sort());
    assert.match(marks['file:main.tex'], /1 comment loses its text/); assert.match(marks[`comment:${removal.id}`], /deleted message cannot be restored/);
  } finally { await r.close(); }
});

test('Undo this send takes a tracked edit, a reply and a resolve back from Overleaf and leaves local files and drafts alone', async () => {
  const r = await linked();
  try {
    const before = r.inspection.docs[0].text, edited = before.replace('Methods.', 'Methods, revised.') + 'Local addition.\n';
    await writeFile(join(r.root, 'main.tex'), edited);
    await r.state.queue(r.draft('reply', { text: 'Local reply' })); await r.state.queue(r.draft('resolve'));
    const sent = await r.sync.push(await r.workflow.prepareSend(), () => true, () => {});
    const [record] = await r.state.history(sent.history);
    assert((record.sent!.files['main.tex'] as SentText).suggestions.length >= 2, 'Track Changes is on: the edit arrived as suggestions');
    assert.deepEqual(Object.values(record.sent!.comments).map(change => [change.kind, change.messageId]), [['reply', 'reply-1'], ['resolve', undefined]]);
    const later = r.draft('reply', { text: 'Queued after the send' }); await r.state.queue(later);
    const data = await r.state.read(), requests = r.fixture.requests.length;
    const standing = await r.workflow.planUndo(record, data, data.observed!, await r.local());
    assert.equal(r.fixture.requests.length, requests, 'The undo summary makes no request');
    const undo = await r.workflow.prepareUndo(sent.history);
    assert.deepEqual(planDifferences(standing.plan!.plan, undo.plan), []);
    assert.deepEqual(undo.stays, []); assert.deepEqual(undo.files.map(file => [file.path, file.added, file.removed]), [['main.tex', 1, 2]]); assert.match(undo.files[0].note!, /Rejects the \d+ suggestions this Send made/);
    assert.deepEqual([...new Set(undo.plan.operations!.map(operation => operation.kind))], ['rejectChange', 'reopen', 'deleteMessage']);
    const result = await r.sync.push(undo.plan, () => true, () => {});
    assert.equal(result.inspection.docs[0].text, before); assert.equal(result.inspection.docs[0].changes.length, 0, 'The suggestions are gone, none added');
    assert.deepEqual(r.fixture.threads.c1.messages.map((message: any) => message.id), ['c1-m1']); assert.equal(r.fixture.threads.c1.resolved, false);
    assert.equal((await r.local())['main.tex'], edited, 'Local files keep the edits');
    assert.deepEqual((await r.state.read()).pending.map(draft => draft.id), [later.id], 'Queued drafts stay queued');
    const history = await r.state.history();
    assert.equal(history[0].undoOf, sent.history); assert.equal(history.find(entry => entry.id === sent.history)!.undoneBy, result.history);
    assert.equal((await r.workflow.prepareSend()).files[0].text, edited, 'The edits are listed as going out again');
    await assert.rejects(r.workflow.prepareUndo(sent.history), /already undone/); await assert.rejects(r.workflow.prepareUndo(result.history), /An undo is not undone/);
  } finally { await r.close(); }
});

test('Undo this send keeps later edits elsewhere, waits for unapplied Overleaf changes, and leaves an overlapped file as sent', async () => {
  const r = await linked(true, false);
  try {
    const before = r.inspection.docs[0].text, edited = before.replace('Methods.', 'Methods, revised.');
    await writeFile(join(r.root, 'main.tex'), edited);
    const sent = await r.sync.push(await r.workflow.prepareSend(), () => true, () => {});
    assert.deepEqual(((await r.state.history(sent.history))[0].sent!.files['main.tex'] as SentText).suggestions, [], 'Track Changes is off: a plain edit');
    r.remoteEdit(edited.replace('Drift: 0.64.', 'Drift: 0.70.'));
    await assert.rejects(r.workflow.prepareUndo(sent.history), /Overleaf changed since your last sync\. Get latest and apply, then undo\./);
    await r.workflow.apply(await r.workflow.preparePull(), () => true);
    const undo = await r.workflow.prepareUndo(sent.history);
    assert.deepEqual(undo.plan.operations, []); assert.equal(undo.files[0].note, undefined);
    assert.equal(undo.plan.files[0].text, before.replace('Drift: 0.64.', 'Drift: 0.70.'), 'The coauthor edit stays');
    // A coauthor rewrites the sent passage before the click: nothing is sent from the old summary.
    r.remoteEdit(edited.replace('Methods, revised.', 'Methods, rewritten by a coauthor.').replace('Drift: 0.64.', 'Drift: 0.70.'));
    await assert.rejects(r.sync.push(undo.plan, () => true, () => {}), /Overleaf changed during review/);
    await r.workflow.apply(await r.workflow.preparePull(), () => true);
    const overlapped = await r.workflow.prepareUndo(sent.history);
    assert.deepEqual(overlapped.files, []); assert.deepEqual(overlapped.plan.files, []);
    assert.deepEqual(overlapped.stays.map(row => row.key), ['file:main.tex']); assert.match(overlapped.stays[0].reason, /Edited on Overleaf at the same place since \(near line 3\)/);
  } finally { await r.close(); }
});

test('Undo this send leaves deletions and answered threads as sent, with the reason', async () => {
  const r = await linked();
  try {
    await r.state.queue(r.draft('reply', { text: 'Local reply' }));
    const replied = await r.sync.push(await r.workflow.prepareSend(), () => true, () => {});
    r.fixture.threads.c1.messages.push({ id: 'answer', user: { id: 'reviewer', name: 'Fixture Reviewer' }, content: 'Thanks.' });
    await r.workflow.apply(await r.workflow.preparePull(), () => true);
    const answered = await r.workflow.prepareUndo(replied.history);
    assert.deepEqual(answered.plan.operations, []); assert.match(answered.stays[0].reason, /answered or changed on Overleaf since/);
    await r.state.queue(r.draft('deleteMessage', { messageId: 'c1-m1', before: (await r.state.read()).acknowledged!.threads.c1 }));
    const removed = await r.sync.push(await r.workflow.prepareSend(), () => true, () => {});
    const deletion = await r.workflow.prepareUndo(removed.history);
    assert.deepEqual(deletion.plan.operations, []); assert.deepEqual(deletion.stays.map(row => [row.label, row.reason]), [['Delete message', 'A recreated message would be a new one written now, not the original.']]);
  } finally { await r.close(); }
});

test('Undo this send of a record without recorded details takes back each reply, not the first one twice', async () => {
  const r = await linked();
  try {
    await r.state.queue(r.draft('reply', { text: 'First reply' })); await r.state.queue(r.draft('reply', { text: 'Second reply' }));
    const sent = await r.sync.push(await r.workflow.prepareSend(), () => true, () => {});
    const [{ sent: _details, ...older }] = await r.state.history(sent.history), data = await r.state.read();
    const undo = await r.workflow.planUndo(older, data, data.observed!, await r.local());
    assert.deepEqual(undo.plan!.plan.operations!.map(operation => [operation.kind, operation.messageId]), [['deleteMessage', 'reply-2'], ['deleteMessage', 'reply-1']]);
    await r.sync.push(undo.plan!.plan, () => true, () => {});
    assert.deepEqual(r.fixture.threads.c1.messages.map((message: any) => message.id), ['c1-m1']); assert.equal((await r.state.read()).partialSend, undefined);
  } finally { await r.close(); }
});

test('Undo this send keeps a new thread that holds a coauthor message, even one captured by the read-back', async () => {
  const r = await linked();
  try {
    const source = r.inspection.docs[0].text;
    await r.state.queue(r.draft('createThread', { threadId: 'mine', text: 'My question', before: undefined, anchor: { from: source.indexOf('Methods'), to: source.indexOf('Methods') + 7, source } }));
    const sent = await r.sync.push(await r.workflow.prepareSend(), () => true, () => {});
    const alone = await r.workflow.prepareUndo(sent.history);
    assert.deepEqual(alone.plan.operations!.map(operation => operation.kind), ['deleteThread'], 'A thread with only your message is taken back');
    r.fixture.threads.mine.messages.push({ id: 'answer', user: { id: 'reviewer', name: 'Fixture Reviewer' }, content: 'Here is my answer.' });
    await r.workflow.apply(await r.workflow.preparePull(), () => true);
    // As if the answer had arrived between the write and the read-back of the Send.
    const [record] = await r.state.history(sent.history), data = await r.state.read();
    record.observed!.comments.mine = structuredClone(data.acknowledged!.threads.mine);
    const undo = await r.workflow.planUndo(record, data, data.observed!, await r.local());
    assert.deepEqual(undo.plan!.plan.operations, []); assert.deepEqual(undo.plan!.stays.map(row => row.reason), ['The thread holds a message this Send did not write.']);
  } finally { await r.close(); }
});

test('Undo this send marks a file whose reversal detaches a comment made since, and the click check sees such marks', async () => {
  const r = await linked(true, false);
  try {
    const before = r.inspection.docs[0].text, edited = before + 'A new sentence.\n';
    await writeFile(join(r.root, 'main.tex'), edited);
    const sent = await r.sync.push(await r.workflow.prepareSend(), () => true, () => {});
    const plain = await r.workflow.prepareUndo(sent.history);
    assert.equal(plain.files[0].mark, undefined);
    // A coauthor comments on the sentence this Send added.
    r.fixture.threads.later = { resolved: false, messages: [{ id: 'later-m1', user: { id: 'reviewer', name: 'Fixture Reviewer' }, content: 'About the new sentence.' }] };
    r.fixture.replies.modern[0].comments.push({ id: 'later', ranges: [{ pos: before.length + 2, length: 3 }] }); r.fixture.replies.modern[1]++;
    await r.workflow.apply(await r.workflow.preparePull(), () => true);
    const undo = await r.workflow.prepareUndo(sent.history);
    assert.equal(undo.files[0].mark, '1 comment loses its text'); assert.equal(undo.plan.files[0].text, before);
    assert.deepEqual(planDifferences(plain.plan, undo.plan).filter(key => key.startsWith('file:')), ['file:main.tex'], 'An undo summary shown before the comment is not sent as it was');
    // Same texts, but the fresh plan would overwrite a suggestion the shown plan did not know.
    const file = undo.plan.files[0], changed = { ...undo.plan, files: [{ ...file, mapping: { ...file.mapping, affectedSuggestions: [{ suggestion: { id: 's', kind: 'insert' as const, pos: 0, text: 'x', author: 'R' }, effect: 'overwritten' }] } }] };
    assert.deepEqual(planDifferences(undo.plan, changed), ['file:main.tex']);
  } finally { await r.close(); }
});
