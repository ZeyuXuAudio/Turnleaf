import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { GitStore } from '../src/core/git';
import { LocalState, workspacePath } from '../src/core/storage';
import { SyncService, remoteTexts, reviewFingerprint } from '../src/core/sync';
import { guardedWrite, requirePermit, validateUpload } from '../src/core/guard';
import { OverleafReader } from '../src/core/overleaf';
import { normalizeDoc } from '../src/core/docState';
import { mapDocument } from '../src/core/ranges';
import { diffText, composeEdits } from '../src/core/diff';
import { reviewRows, renderReviewLog } from '../src/core/review';
import { startFixtureServer, fixtureCookie } from './fixtureServer';

async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'overleaf-workflow-')), git = new GitStore(root);
  await git.run(['init', '-b', 'main']); await git.run(['config', 'user.name', 'Test Author']); await git.run(['config', 'user.email', 'test@example.invalid']);
  const commit = async (texts: Record<string, string>, message = 'test revision') => { for (const [path, text] of Object.entries(texts)) await writeFile(join(root, path), text); await git.run(['add', '.']); await git.run(['commit', '-m', message]); return git.head(); };
  return { root, git, commit, close: () => rm(root, { recursive: true, force: true }) };
}

test('first-pull baseline preserves local revisions and merges remote edits; snapshots do not touch files', async () => {
  const r = await repo();
  try {
    const baseline = await r.commit({ 'main.tex': 'one\n\ntwo\n\nthree\n' });
    await r.commit({ 'main.tex': 'local one\n\ntwo\n\nthree\n' });
    assert.equal(await r.git.baseline({ 'main.tex': 'one\n\ntwo\n\nthree\n' }), baseline);
    const before = await r.git.head(); const snapshot = await r.git.record({ 'main.tex': 'one\n\ntwo\n\nremote three\n' }, baseline);
    assert.equal(await r.git.head(), before); assert.equal(await r.git.clean(), true);
    assert.equal(await r.git.merged(['main.tex']), false);
    await r.git.merge(snapshot);
    assert.equal(await readFile(join(r.root, 'main.tex'), 'utf8'), 'local one\n\ntwo\n\nremote three\n');
    assert.equal(await r.git.merged(['main.tex']), true);
    assert.equal(await r.git.record({ 'main.tex': 'one\n\ntwo\n\nremote three\n' }), snapshot);
  } finally { await r.close(); }
});
test('first snapshot exists even when equal, conflicts preserve local text, failed verification never blesses HEAD', async () => {
  const r = await repo();
  try {
    const base = await r.commit({ 'main.tex': 'base\n' }); const first = await r.git.record({ 'main.tex': 'base\n' }, base); assert.notEqual(first, base); await r.git.merge(first);
    const head = await r.commit({ 'main.tex': 'local\n' });
    const failed = await r.git.record({ 'main.tex': 'remote\n' }, undefined, undefined, true);
    assert.equal((await r.git.run(['merge-base', head, failed])).trim(), first);
    await assert.rejects(r.git.merge(failed)); assert.match(await readFile(join(r.root, 'main.tex'), 'utf8'), /local/); assert.match(await readFile(join(r.root, 'main.tex'), 'utf8'), /remote/);
  } finally { await r.close(); }
});
test('stash restoration preserves staged and untracked work, leaving unrelated stashes alone', async () => {
  const r = await repo();
  try {
    await r.commit({ 'main.tex': 'base\n', 'notes.txt': 'base\n' });
    await writeFile(join(r.root, 'notes.txt'), 'older stash\n'); await r.git.run(['stash', 'push', '-m', 'unrelated']);
    await writeFile(join(r.root, 'notes.txt'), 'staged\n'); await r.git.run(['add', 'notes.txt']); await writeFile(join(r.root, 'scratch.txt'), 'untracked\n');
    const snapshot = await r.git.record({ 'main.tex': 'remote\n' }, await r.git.head()); await r.git.merge(snapshot, true);
    assert.match(await r.git.run(['diff', '--cached']), /staged/); assert.equal(await readFile(join(r.root, 'scratch.txt'), 'utf8'), 'untracked\n');
    const stashes = await r.git.run(['stash', 'list']); assert.match(stashes, /unrelated/); assert.doesNotMatch(stashes, /turnleaf/);
  } finally { await r.close(); }
});
test('successful push snapshot sets the next merge base correctly; unchanged failed upload is retryable', async () => {
  const r = await repo();
  try {
    const head = await r.commit({ 'main.tex': 'base\n' }); const first = await r.git.record({ 'main.tex': 'base\n' }, head); await r.git.merge(first);
    const revision = await r.commit({ 'main.tex': 'local\n' });
    await r.git.record({ 'main.tex': 'base\n' }, undefined, undefined, true); assert.equal(await r.git.merged(['main.tex']), true);
    const verified = await r.git.record({ 'main.tex': 'local\n' }, undefined, revision, true);
    assert.equal((await r.git.run(['merge-base', 'HEAD', verified])).trim(), revision); assert.equal(await r.git.merged(['main.tex']), true);
  } finally { await r.close(); }
});
test('import checks reject destructive input and preserve U+FEFF', () => {
  for (const bytes of [Buffer.from([0xff]), Buffer.from('x\0'), Buffer.from('% 😀'), Buffer.from('𝐀'), Buffer.from('a\r\nb'), Buffer.from('a\rb'), Buffer.alloc(1024 * 1024 + 1, 65)]) assert.throws(() => validateUpload('main.tex', bytes));
  assert.equal(validateUpload('main.tex', Buffer.from('\ufeffGrüße α\n')), '\ufeffGrüße α\n');
});
test('write guard needs permission and exact confirmation, logs failures without secrets, rejects forged permits', async () => {
  const r = await repo();
  try {
    await r.commit({ 'main.tex': 'a' }); const state = new LocalState(r.git, 'https://example.invalid', 'p', ['main.tex']); let calls = 0;
    const action = { kind: 'reply' as const, projectId: 'p', threadId: 't', text: 'hello' };
    await assert.rejects(guardedWrite(state, action, () => false, async () => true, async () => ++calls, () => {}));
    await assert.rejects(guardedWrite(state, action, () => true, async () => false, async () => ++calls, () => {})); assert.equal(calls, 0);
    await guardedWrite(state, action, () => true, async () => true, async permit => { assert.equal(requirePermit(permit).text, 'hello'); assert.throws(() => requirePermit(permit)); calls++; }, () => {});
    assert.equal(calls, 1); assert.throws(() => requirePermit({ action }));
    assert.match(await readFile(await state.path('writes.jsonl'), 'utf8'), /"result":"ok"/); assert.equal(await r.git.clean(), true);
    await symlink(tmpdir(), join(r.root, 'escape')); await assert.rejects(workspacePath(r.root, 'escape/data.json'));
  } finally { await r.close(); }
});
test('end-to-end dry run, upload, verification, replies and resolution use guarded HTTP routes', async () => {
  const fixture = await startFixtureServer({ writable: true }), r = await repo();
  try {
    const reader = new OverleafReader(fixture.baseUrl, fixtureCookie); await reader.signIn(); const i = await reader.inspect('test-project', ['main.tex', 'references.bib']);
    const base = await r.commit(remoteTexts(i)), state = new LocalState(r.git, fixture.baseUrl, i.projectId, ['main.tex', 'references.bib']), s = new SyncService(r.git, state, reader, i.projectId, ['main.tex', 'references.bib']);
    const snap = await s.recordPull(i, base); await r.git.merge(snap); await r.commit({ 'main.tex': i.docs[0].text + 'Local addition.\n' });
    const before = await readFile(await state.path(`cache/${(state as any).key}.json`), 'utf8');
    const dry = await s.preflight(); assert.equal(dry.files.length, 1);
    assert.equal(await readFile(await state.path(`cache/${(state as any).key}.json`), 'utf8'), before); assert.equal(await r.git.snapshot(), snap);
    const result = await s.push(await s.preflight(), () => true, () => {}); assert.deepEqual(result.mismatches, []); assert.deepEqual(result.warnings, []); assert.equal(await r.git.merged(s.paths), true);
    for (const kind of ['reply', 'resolve', 'reopen'] as const) await guardedWrite(state, { kind, projectId: i.projectId, docId: 'modern', threadId: 'c1', text: 'Confirmed reply' }, () => true, async () => true, p => reader.write(p), () => {});
    const updated = await reader.inspect(i.projectId, s.paths); assert.equal(updated.threads.c1.messages.at(-1)?.text, 'Confirmed reply'); assert.equal(updated.threads.c1.resolved, false);
  } finally { await fixture.close(); await r.close(); }
});
test('freshness changes reject without advancing cache; partial push requires Pull', async () => {
  const fixture = await startFixtureServer({ writable: true }), r = await repo();
  try {
    const reader = new OverleafReader(fixture.baseUrl, fixtureCookie), paths = ['main.tex', 'references.bib']; await reader.signIn(); const i = await reader.inspect('test-project', paths);
    const base = await r.commit(remoteTexts(i)), state = new LocalState(r.git, fixture.baseUrl, i.projectId, paths), s = new SyncService(r.git, state, reader, i.projectId, paths);
    await r.git.merge(await s.recordPull(i, base)); await r.commit(Object.fromEntries(i.docs.map(d => [d.path, d.text + 'local\n'])));
    fixture.threads.c1.messages[0].content = 'changed reply'; await assert.rejects(s.preflight(), /Refresh/); assert.equal((await state.cache()).inspection?.threads.c1.messages[0].text, i.threads.c1.messages[0].text);
    await s.refresh(); fixture.failUpload('references.bib'); await assert.rejects(s.push(await s.preflight(), () => true, () => {}), /Confirmed uploads: main.tex/);
    assert.deepEqual((await state.cache()).partialPush, ['main.tex']); await assert.rejects(s.preflight(), /Run Pull/);
    fixture.failUpload(''); const pulled = await s.fetchPull(); await r.git.merge(await s.recordPull(pulled)); const remaining = await s.preflight(); assert.deepEqual(remaining.files.map(f => f.doc.path), ['references.bib']);
  } finally { await fixture.close(); await r.close(); }
});
test('incremental composition preserves source/target and insertion boundaries without a full diff', () => {
  const original = 'abcdef', d = diffText(original, 'abXYcdef', 0).diffs;
  const composed = composeEdits(original, d, [{ rangeOffset: 4, rangeLength: 2, text: '!' }]);
  assert.equal(composed.filter(d => d[0] !== 1).map(d => d[1]).join(''), original);
  assert.equal(composed.filter(d => d[0] !== -1).map(d => d[1]).join(''), 'abXY!ef');
  // A replacement at the end of a comment must delete before inserting; otherwise
  // sharejs would incorrectly absorb the replacement into the surviving anchor.
  const doc = normalizeDoc('main.tex', 'd', [['abcde'], 1, [], { comments: [{ op: { p: 0, c: 'abc', t: 't' } }] }, 'sharejs-text-ot']);
  const replacement = composeEdits(doc.text, [[0, doc.text]], [{ rangeOffset: 2, rangeLength: 1, text: 'XY' }]);
  assert.deepEqual(mapDocument(doc, 'abXYde', false, replacement).comments, mapDocument(doc, 'abXYde', false, diffText(doc.text, 'abXYde', 0).diffs).comments);
});

test('manual reconciliation is explicit, preserves local text, and refuses changed remote text', async () => {
  const fixture = await startFixtureServer({ writable: true }), r = await repo();
  try {
    const reader = new OverleafReader(fixture.baseUrl, fixtureCookie), paths = ['main.tex', 'references.bib']; await reader.signIn();
    const i = await reader.inspect('test-project', paths); await r.commit({ ...remoteTexts(i), 'main.tex': 'reconciled local text\n' });
    const state = new LocalState(r.git, fixture.baseUrl, i.projectId, paths), s = new SyncService(r.git, state, reader, i.projectId, paths);
    await assert.rejects(s.markReconciled(), /choose Reconcile/);
    await s.reconciliation(i); fixture.replies.modern[0].content += 'new remote edit\n'; fixture.replies.modern[1]++;
    assert((await s.markReconciled()).changed); assert.equal(await r.git.snapshot(), undefined);
    const done = await s.markReconciled(); assert(done.snapshot); assert.equal(await readFile(join(r.root, 'main.tex'), 'utf8'), 'reconciled local text\n'); assert.equal(await r.git.merged(paths), true);
  } finally { await fixture.close(); await r.close(); }
});
test('remote edits after the confirmation snapshot stop uploads; local statuses and thread order do not affect freshness', async () => {
  const fixture = await startFixtureServer({ writable: true }), r = await repo();
  try {
    const reader = new OverleafReader(fixture.baseUrl, fixtureCookie), paths = ['main.tex', 'references.bib']; await reader.signIn(); const i = await reader.inspect('test-project', paths);
    const base = await r.commit(remoteTexts(i)), state = new LocalState(r.git, fixture.baseUrl, i.projectId, paths), s = new SyncService(r.git, state, reader, i.projectId, paths);
    await r.git.merge(await s.recordPull(i, base)); await r.commit({ 'main.tex': i.docs[0].text + 'local\n' });
    const reversed = { ...i, threads: Object.fromEntries(Object.entries(i.threads).reverse()) }; assert.equal(reviewFingerprint(i, await state.cache()), reviewFingerprint(reversed, await state.cache()));
    const plan = await s.preflight(); fixture.threads.c1.resolved = true;
    await assert.rejects(s.push(plan, () => true, () => {}), /changed while confirming/);
    assert.equal(fixture.requests.filter(r => r.path.endsWith('/upload')).length, 0); assert.equal((await state.cache()).partialPush, undefined);
  } finally { await fixture.close(); await r.close(); }
});
test('removed anchors and local statuses survive cache reload; review log ordering is stable', async () => {
  const fixture = await startFixtureServer(), r = await repo();
  try {
    const reader = new OverleafReader(fixture.baseUrl, fixtureCookie), paths = ['main.tex', 'references.bib']; await reader.signIn(); const i = await reader.inspect('test-project', paths);
    await r.commit(remoteTexts(i)); const state = new LocalState(r.git, fixture.baseUrl, i.projectId, paths), s = new SyncService(r.git, state, reader, i.projectId, paths); await s.saveRefresh(i);
    await state.setReview('c1', { status: 'declined', reason: 'keep wording', updated: '2026-10-27' });
    const gone = structuredClone(i); gone.docs[0].comments = gone.docs[0].comments.filter(c => c.threadId !== 'c1'); await s.saveRefresh(gone);
    const cache = await state.cache(), rows = reviewRows(gone, cache, remoteTexts(gone)); assert.equal(rows.find(r => r.thread.id === 'c1')?.anchor.label, 'anchor removed');
    const log = renderReviewLog(gone, rows, await state.reviews()); assert.match(log, /declined: keep wording/); assert.match(log, /Unknown positions/); assert(log.indexOf('c1') < log.indexOf('c4'));
  } finally { await fixture.close(); await r.close(); }
});
test('snapshot branches cannot be reused for another linked project', async () => {
  const r = await repo(); try {
    const base = await r.commit({ 'main.tex': 'base\n' }), a = new LocalState(r.git, 'https://example.invalid', 'project-a', ['main.tex']);
    await a.claimSnapshot(); await r.git.record({ 'main.tex': 'base\n' }, base);
    await assert.rejects(new LocalState(r.git, 'https://example.invalid', 'project-b', ['main.tex']).claimSnapshot(), /different project/);
  } finally { await r.close(); }
});
