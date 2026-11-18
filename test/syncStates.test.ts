import test from 'node:test';
import assert from 'node:assert/strict';
import { access, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProjectStore, CommentDraft } from '../src/core/projectStore';
import { ReviewWorkflow, SyncService, sameRemote } from '../src/core/folderWorkflow';
import { SessionExpiredError } from '../src/core/errors';
import { arrangeState, absentPath, stateText } from './syncStates';

// One or more tests per state of the Sync State Map. The coverage table in
// The Sync State Map in syncStates.ts names them.
const deletedOnOverleaf = (path: string) => new RegExp(`${path.replace('.', '\\.')} was deleted or renamed on Overleaf since your last sync\\. Send does not bring it back`);
const reply = (threadId: string, text: string, before: any): CommentDraft => ({ id: randomUUID(), kind: 'reply', path: 'main.tex', docId: 'modern', threadId, text, before, created: new Date().toISOString() });

test('link-neither-side (Link 1): Choose files lists only Overleaf files, and a selected file missing on both sides is refused', async () => {
  const r = await arrangeState('link-neither-side');
  try {
    assert.deepEqual((await r.reader.listSourceFiles('test-project')).paths, ['main.tex', 'references.bib'], 'A file that exists on neither side cannot be chosen');
    await assert.rejects(r.workflow.preparePull(), /draft\.tex is missing in the local folder and on Overleaf\. Remove it in Choose files\.$/);
    await assert.rejects(r.workflow.prepareSend(), /Get latest to establish the local sync baseline/);
    await assert.rejects(access(join(r.root, absentPath)), 'Nothing is created locally');
    assert.deepEqual(r.writes(), []);
    assert.equal((await r.state.read()).acknowledged, undefined);
  } finally { await r.close(); }
});

test('link-local-only (Link 2): Get latest leaves a local-only file alone, and Send creates it on Overleaf', async () => {
  const r = await arrangeState('link-local-only');
  try {
    // Get latest links the files Overleaf has; the local-only file waits for Send.
    const pull = await r.workflow.preparePull();
    assert(!pull.files.some(file => file.path === absentPath), 'Get latest does not touch the local-only file');
    await r.workflow.apply(pull, () => true);
    assert.equal((await r.local())[absentPath], stateText.localDraft, 'The local draft is untouched');
    assert.deepEqual(r.writes(), [], 'Nothing is written to Overleaf before Send');
    const plan = await r.workflow.prepareSend();
    assert.deepEqual(plan.files.map(file => [file.doc.path, file.create?.folders]), [[absentPath, []]]);
    await r.sync.push(plan, () => true, () => {});
    const created = r.fixture.tree.docs.find((doc: any) => doc.name === absentPath);
    assert(created, 'Send created the file on Overleaf');
    assert.equal(r.fixture.replies[created._id][0].content, stateText.localDraft);
    assert.deepEqual((await r.workflow.prepareSend()).files, [], 'Then in sync');
    assert.deepEqual((await r.reader.listSourceFiles('test-project')).paths, ['draft.tex', 'main.tex', 'references.bib']);
  } finally { await r.close(); }
});

test('link-overleaf-only (Link 3): an empty folder receives every file without a first-sync choice, then is in sync', async () => {
  const r = await arrangeState('link-overleaf-only');
  try {
    const plan = await r.workflow.preparePull();
    assert.deepEqual(plan.files.map(f => [f.path, f.conflict, f.firstSync, f.before]), [['main.tex', false, undefined, ''], ['references.bib', false, undefined, '']]);
    assert.deepEqual(await r.local(), { 'main.tex': null, 'references.bib': null }, 'Nothing is written before Apply');
    await r.workflow.apply(plan, () => true);
    assert.deepEqual(await r.local(), r.remote);
    assert((await r.state.read()).acknowledged);
    assert.deepEqual((await r.workflow.preparePull()).files, []);
    assert.deepEqual((await r.workflow.prepareSend()).files, []);
    assert.deepEqual(r.writes(), []);
  } finally { await r.close(); }
});

test('link-overleaf-only (Link 3): an existing empty local file is not Link 3 and gets the first-sync choice', async () => {
  const r = await arrangeState('link-overleaf-only');
  try {
    await r.put('main.tex', '');
    const plan = await r.workflow.preparePull(), main = plan.files.find(f => f.path === 'main.tex')!, bib = plan.files.find(f => f.path === 'references.bib')!;
    assert(main.conflict && main.firstSync, 'An empty file differs from Overleaf (Link 5)');
    assert(!bib.conflict && !bib.firstSync, 'The missing file is still created (Link 3)');
  } finally { await r.close(); }
});

test('link-same-both (Link 4): identical files need no choice, Use this baseline writes nothing, and the baseline is recorded', async () => {
  for (const mainText of [stateText.base, '']) {
    const r = await arrangeState('link-same-both', { mainText });
    try {
      const before = await stat(join(r.root, 'main.tex'));
      const plan = await r.workflow.preparePull();
      assert.deepEqual(plan.files, [], `No file to apply (${mainText ? 'text' : 'empty'} on both sides)`);
      assert(plan.comments.length > 0, "The project's comments arrive with the first baseline, so the button reads Apply (N)");
      await r.workflow.apply(plan, () => true);
      assert.equal((await stat(join(r.root, 'main.tex'))).mtimeMs, before.mtimeMs, 'The local file is not rewritten');
      assert.deepEqual(await r.local(), r.remote);
      assert.deepEqual(r.writes(), [], 'Nothing is uploaded');
      assert((await r.state.read()).acknowledged);
      const again = await r.workflow.preparePull();
      assert.deepEqual([again.files, again.comments], [[], []]);
      assert.deepEqual((await r.workflow.prepareSend()).files, []);
    } finally { await r.close(); }
  }
});

test('link-different-both (Link 5): a mixed first sync creates the missing file and leaves the kept file to send', async () => {
  const r = await arrangeState('link-different-both');
  try {
    await rm(join(r.root, 'references.bib'));
    const plan = await r.workflow.preparePull();
    const main = plan.files.find(f => f.path === 'main.tex')!, bib = plan.files.find(f => f.path === 'references.bib')!;
    assert(main.conflict && main.firstSync);
    assert(!bib.conflict);
    await assert.rejects(r.workflow.apply(plan, () => true), /Resolve every file conflict/, 'Apply waits for the choice on every differing file');
    assert.equal((await r.local())['references.bib'], null, 'A refused Apply creates nothing');
    await r.workflow.apply(r.workflow.resolve(plan, 'main.tex', main.before), () => true);
    assert.equal((await r.local())['references.bib'], r.remote['references.bib']);
    assert.equal((await r.local())['main.tex'], stateText.differentLocal);
    const send = await r.workflow.prepareSend();
    assert.deepEqual(send.files.map(f => [f.doc.path, f.text]), [['main.tex', stateText.differentLocal]], 'Keep my version leads to Sync 2');
    assert.deepEqual(r.writes(), []);
  } finally { await r.close(); }
});

test('link-different-both (Link 5): an empty Overleaf file facing local text is offered the first-sync choice, not refused', async () => {
  const r = await arrangeState('link-different-both', { mainText: '' });
  try {
    const plan = await r.workflow.preparePull(), main = plan.files.find(f => f.path === 'main.tex')!;
    assert(main.conflict && main.firstSync);
    assert.equal(main.remote, '');
    await r.workflow.apply(r.workflow.resolve(plan, 'main.tex', main.before), () => true);
    const send = await r.workflow.prepareSend();
    assert.deepEqual(send.files.map(f => f.text), [stateText.differentLocal]);
    await r.sync.push(send, () => true, () => {});
    assert.equal(r.fixture.replies.modern[0].content, stateText.differentLocal);
  } finally { await r.close(); }
});

// The write-skip decision of a background check (acceptInspection in
// src/extension/workspace.ts) is extension code and is not run here: this test
// checks its input (sameRemote) and that the summary's own inputs write nothing.
test('sync-in-sync (Sync 1): repeated reads find nothing to send or apply, match the stored read, and leave Overleaf and the baseline as they are', async () => {
  const r = await arrangeState('sync-in-sync');
  try {
    const stored = await r.state.read(), file = await r.stateFile();
    for (let i = 0; i < 3; i++) {
      const fresh = await r.sync.fetchPull();
      assert(sameRemote(stored.observed!, fresh), 'The check would skip its state write');
      const plan = await r.workflow.planSend(stored, fresh, await r.local());
      assert.deepEqual([plan.plan?.files, plan.plan?.comments, plan.plan?.incoming], [[], [], undefined]);
    }
    assert.equal(await r.stateFile(), file, 'The state file is unchanged');
    const pull = await r.workflow.preparePull();
    assert.deepEqual([pull.files, pull.comments], [[], []]);
    // Get latest records what it read (observed) and nothing else.
    const after = await r.state.read();
    assert.deepEqual([after.revision, after.acknowledged, after.pending, after.localApply, after.partialSend], [stored.revision, stored.acknowledged, stored.pending, undefined, undefined]);
    assert.deepEqual(r.writes(), []);
  } finally { await r.close(); }
});

test('sync-overleaf-ahead (Sync 3): a file deleted on Overleaf blocks Get latest and Send for every file', async () => {
  // One missing file stops the whole selection (the map's "always back in
  // sync" promise is not kept here), and Send does not create it again.
  const r = await arrangeState('sync-overleaf-ahead');
  try {
    await r.put('references.bib', r.remote['references.bib'] + '% local edit\n');
    r.fixture.removeDoc('legacy');
    const before = await r.local(), data = await r.state.read();
    await assert.rejects(r.workflow.preparePull(), deletedOnOverleaf('references.bib'));
    await assert.rejects(r.workflow.prepareSend(), deletedOnOverleaf('references.bib'));
    assert.deepEqual(await r.local(), before, 'Both local files stay as they are');
    assert.equal((await r.state.read()).revision, data.revision);
    assert.deepEqual(r.writes(), []);
  } finally { await r.close(); }
});

test('sync-overleaf-ahead (Sync 3): a text-only change is previewed, applied only on Apply, and leaves the file in sync', async () => {
  const r = await arrangeState('sync-overleaf-ahead');
  try {
    const plan = await r.workflow.preparePull();
    assert.deepEqual(plan.files.map(f => [f.path, f.before, f.after, f.conflict]), [['main.tex', stateText.base, stateText.remoteEdit, false]]);
    assert.deepEqual(plan.comments, []);
    assert.equal((await r.local())['main.tex'], stateText.base, 'Nothing changes locally before Apply');
    await r.workflow.apply(plan, () => true);
    assert.equal((await r.local())['main.tex'], stateText.remoteEdit);
    assert.deepEqual((await r.workflow.preparePull()).files, []);
    assert.deepEqual((await r.workflow.prepareSend()).files, []);
  } finally { await r.close(); }
});

test('sync-both-merge-clean (Sync 4): Apply & send keeps both text edits and both replies', async () => {
  const r = await arrangeState('sync-both-merge-clean');
  try {
    const c1 = r.inspection.threads.c1;
    await r.state.queue(reply('c1', 'My local reply.', structuredClone(c1)));
    r.fixture.threads.c1.messages.push({ id: 'coauthor-reply', user: { id: 'other', name: 'Coauthor' }, content: 'Coauthor reply.' });
    const plan = await r.workflow.prepareSend();
    assert(plan.incoming, 'Overleaf changes are applied first');
    assert.equal(plan.incoming.comments.length, 1);
    assert.deepEqual(plan.files.map(f => f.text), [stateText.merged]);
    const applied = await r.workflow.apply(plan.incoming, () => true);
    await r.sync.push(r.workflow.afterIncoming(plan, applied), () => true, () => {});
    assert.equal(r.fixture.replies.modern[0].content, stateText.merged);
    assert.equal((await r.local())['main.tex'], stateText.merged);
    assert.deepEqual(r.fixture.threads.c1.messages.map((m: any) => m.content), [c1.messages[0].text, 'Coauthor reply.', 'My local reply.']);
    const after = await r.workflow.preparePull();
    assert.deepEqual([after.files, after.comments], [[], []]);
  } finally { await r.close(); }
});

test('sync-both-overlap (Sync 5): resolve, Apply leaves the resolution to send (Sync 2), and Send brings it in sync', async () => {
  const r = await arrangeState('sync-both-overlap');
  try {
    await assert.rejects(r.workflow.prepareSend(), (error: any) => error.block?.way === 'getLatest' && /near line 7/.test(error.message));
    const plan = await r.workflow.preparePull();
    assert(plan.files[0].conflict && !plan.files[0].firstSync);
    const resolution = stateText.base.replace('0.64', '0.59');
    await r.workflow.apply(r.workflow.resolve(plan, 'main.tex', resolution), () => true);
    const data = await r.state.read();
    assert.equal(data.acknowledged!.docs.find(d => d.path === 'main.tex')!.text, stateText.remoteOverlap, "The baseline is Overleaf's text");
    assert.equal((await r.local())['main.tex'], resolution);
    const send = await r.workflow.prepareSend();
    assert.equal(send.incoming, undefined);
    assert.deepEqual(send.files.map(f => [f.doc.text, f.text]), [[stateText.remoteOverlap, resolution]]);
    await r.sync.push(send, () => true, () => {});
    assert.equal(r.fixture.replies.modern[0].content, resolution);
    const after = await r.workflow.preparePull();
    assert.deepEqual([after.files, after.comments], [[], []]);
    assert.deepEqual((await r.workflow.prepareSend()).files, []);
  } finally { await r.close(); }
});

test('session-expired-during-get-latest: an expired session leaves the baseline, comments and drafts, and Get latest works after signing in again', async () => {
  const r = await arrangeState('sync-local-ahead');
  try {
    await r.state.queue(reply('c1', 'Queued before the session expired.', structuredClone(r.inspection.threads.c1)));
    const file = await r.stateFile(), local = await r.local();
    r.fixture.forbidNextThreadReads(2);
    await assert.rejects(r.workflow.preparePull(), SessionExpiredError);
    assert.equal(await r.stateFile(), file, 'Baseline, cached comments and drafts are untouched');
    assert.deepEqual(await r.local(), local);
    const plan = await r.workflow.preparePull();
    assert.deepEqual(plan.files, [], 'Nothing incoming; the local edit stays local');
    const send = await r.workflow.prepareSend();
    assert.equal(send.files.length, 1);
    assert.equal(send.comments.length, 1);
    assert.deepEqual(r.writes(), []);
  } finally { await r.close(); }
});

test('changed-file-selection: a new selection starts without a baseline; the old one keeps its drafts and partial-send block out of sight', async () => {
  // Today's behaviour: state is partitioned by file selection, so drafts and a
  // partial-send block are hidden until the old selection is chosen again.
  const r = await arrangeState('sync-in-sync');
  try {
    await r.state.queue(reply('c1', 'Queued with both files selected.', structuredClone(r.inspection.threads.c1)));
    await r.state.update(data => { data.partialSend = { history: 'h-old', confirmed: [], uncertain: ['file:main.tex'] }; });
    const narrower = new ProjectStore(r.root, r.fixture.baseUrl, 'test-project', ['main.tex']);
    const workflow = new ReviewWorkflow(new SyncService(narrower, r.reader));
    const fresh = await narrower.read();
    assert.deepEqual([fresh.acknowledged, fresh.pending, fresh.partialSend], [undefined, [], undefined]);
    assert.deepEqual((await workflow.planSend(fresh, r.inspection, { 'main.tex': stateText.base })).blocked, { way: 'getLatest', message: 'Get latest to establish the local sync baseline.', code: 'incoming' });
    const plan = await workflow.preparePull();
    assert.deepEqual(plan.files, [], 'The unchanged file is Link 4 in the new selection');
    await workflow.apply(plan, () => true);
    assert.deepEqual((await workflow.prepareSend()).comments, [], "The old selection's draft is not listed");
    const old = await r.state.read();
    assert.equal(old.pending.length, 1, 'Choosing the old selection again restores its draft');
    assert.equal(old.partialSend?.history, 'h-old');
    await assert.rejects(r.workflow.prepareSend(), /Get latest to review the interrupted send/);
    assert.deepEqual(r.writes(), []);
  } finally { await r.close(); }
});

test('extension-upgrade-old-baseline: a baseline saved before 0.7.2 is loaded from disk and resumes with nothing incoming', async () => {
  // Before 0.7.2 a stored suggestion had the author's user ID as its author and
  // no authorId. 0.7.4 fixed the false "Use this baseline" prompt this caused.
  const r = await arrangeState('sync-in-sync', { suggestion: true });
  try {
    await r.state.queue(reply('c1', 'Queued before the upgrade.', structuredClone(r.inspection.threads.c1)));
    const current = await r.state.read(), suggestion = current.acknowledged!.docs.find(d => d.path === 'main.tex')!.changes[0];
    assert.equal(suggestion?.authorId, 'reviewer', 'The arranged baseline holds a suggestion');
    const older = (inspection: any) => { for (const doc of inspection.docs) for (const change of doc.changes) { change.author = change.authorId; delete change.authorId; } };
    await r.state.update(data => { older(data.acknowledged); older(data.observed); });
    const upgraded = new ProjectStore(r.root, r.fixture.baseUrl, 'test-project', r.paths);
    const workflow = new ReviewWorkflow(new SyncService(upgraded, r.reader)), data = await upgraded.read();
    assert.equal(data.acknowledged!.docs.find(d => d.path === 'main.tex')!.changes[0].authorId, undefined, 'The old format is what is on disk');
    const pull = await workflow.preparePull();
    assert.deepEqual([pull.files, pull.comments], [[], []], 'Get latest finds nothing to apply');
    const send = await workflow.prepareSend();
    assert.equal(send.incoming, undefined, 'No Apply & send for a baseline that only lacks author IDs');
    assert.deepEqual(send.files, []);
    assert.equal(send.comments.length, 1, 'The queued reply survives the upgrade');
    assert.equal((await upgraded.read()).revision, current.revision);
    assert.deepEqual(r.writes(), []);
  } finally { await r.close(); }
});
