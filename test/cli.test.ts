import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir, readdir, symlink, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { run, exitCodes, failureOf, policyProblems, signInProfile } from '../src/cli/turnleaf';
import { fixtureCookie, fixtureOwner, startFixtureServer } from './fixtureServer';
import { createHash } from 'node:crypto';
import { ProjectStore, turnleafIgnore } from '../src/core/projectStore';
import { SessionExpiredError, SyncError } from '../src/core/errors';
import type { PushPlan } from '../src/core/folderWorkflow';

async function cli(options: { trackChanges?: boolean; cookie?: string | null } = {}) {
  const fixture = await startFixtureServer({ writable: true, trackChanges: options.trackChanges ?? true });
  fixture.replies.modern[0] = { content: 'Rain was excluded.\n\nMethods.\n\nResults.\n\nDrift: 0.64.\n', comments: [{ id: 'c1', ranges: [{ pos: 0, length: 4 }] }], trackedChanges: [] };
  const root = await mkdtemp(join(tmpdir(), 'turnleaf-cli-')), config = await mkdtemp(join(tmpdir(), 'turnleaf-cli-config-'));
  const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: config, ...options.cookie !== null && { TURNLEAF_COOKIE: options.cookie ?? fixtureCookie } };
  // raw: exactly these arguments and environment additions, without --folder and --base-url.
  const raw = async (argv: string[], extra: NodeJS.ProcessEnv = {}) => {
    const out: string[] = [], err: string[] = [];
    const code = await run(argv, { out: line => out.push(line), err: line => err.push(line), env: { ...env, ...extra }, cwd: root });
    return { code, out: out.join('\n'), err: err.join('\n'), json: () => JSON.parse(out.join('\n')) };
  };
  const exec = (...argv: string[]) => raw([...argv, '--folder', root, '--base-url', fixture.baseUrl]);
  const reviewDir = async () => (await exec('pull', '--json')).json().reviewFiles as string;
  return { fixture, root, config, env, raw, exec, reviewDir, close: async () => { await fixture.close(); await rm(root, { recursive: true, force: true }); await rm(config, { recursive: true, force: true }); } };
}

test('cli: link, pull into an empty folder, queue a new comment from a file and send it only with --yes', async () => {
  const c = await cli();
  try {
    assert.equal((await c.exec('link', 'test-project', '--files', 'main.tex,references.bib')).code, exitCodes.ok);
    // Git ignores .turnleaf/ from the link on, before any pull.
    assert.equal(await readFile(join(c.root, '.turnleaf', '.gitignore'), 'utf8'), turnleafIgnore);
    const pulled = await c.exec('pull', '--json');
    assert.equal(pulled.code, exitCodes.ok, pulled.err);
    assert.match(await readFile(join(c.root, 'main.tex'), 'utf8'), /Rain was excluded/);
    const review = pulled.json().reviewFiles as string;
    await readFile(join(review, 'REVIEW.md'), 'utf8');
    await writeFile(join(review, 'new', 'agent-1.json'), JSON.stringify({ id: 'agent-1', path: 'main.tex', quote: 'Methods.', text: 'Please describe the sampling rate.' }));
    const dry = await c.exec('send', '--dry-run', '--json');
    assert.equal(dry.code, exitCodes.ok, dry.err);
    assert.deepEqual(dry.json().comments.map((comment: { label: string }) => comment.label), ['New comment']);
    const before = Object.keys(c.fixture.threads).length;
    assert.equal((await c.exec('send')).code, exitCodes.usage);
    assert.equal(Object.keys(c.fixture.threads).length, before);
    const sent = await c.exec('send', '--yes', '--comments-only', '--json');
    assert.equal(sent.code, exitCodes.ok, sent.err);
    assert(Object.values(c.fixture.threads).some((thread: any) => thread.messages.some((message: any) => message.content === 'Please describe the sampling rate.')));
    assert.equal((await c.exec('send', '--yes', '--json')).json().sent, false);
  } finally { await c.close(); }
});

test('cli: edits are refused while Track Changes is off unless --allow-untracked-edits is given', async () => {
  const c = await cli({ trackChanges: false });
  try {
    await c.exec('link', 'test-project', '--files', 'main.tex');
    assert.equal((await c.exec('pull')).code, exitCodes.ok);
    const text = await readFile(join(c.root, 'main.tex'), 'utf8');
    await writeFile(join(c.root, 'main.tex'), text.replace('Methods.', 'Methods and materials.'));
    const version = c.fixture.replies.modern[1];
    const refused = await c.exec('send', '--yes', '--json');
    assert.equal(refused.code, exitCodes.blocked);
    assert.match(refused.json().error, /Track Changes is off/);
    assert.equal(refused.json().code, 'policy');
    assert.equal(c.fixture.replies.modern[1], version);
    const sent = await c.exec('send', '--yes', '--allow-untracked-edits');
    assert.equal(sent.code, exitCodes.ok, sent.err);
    assert(c.fixture.replies.modern[1] > version);
  } finally { await c.close(); }
});

test('cli: --comments-only refuses when saved files changed', async () => {
  const c = await cli();
  try {
    await c.exec('link', 'test-project', '--files', 'main.tex');
    await c.exec('pull');
    await writeFile(join(c.root, 'main.tex'), (await readFile(join(c.root, 'main.tex'), 'utf8')) + 'Extra.\n');
    const refused = await c.exec('send', '--yes', '--comments-only');
    assert.equal(refused.code, exitCodes.blocked);
    assert.match(refused.err, /comments-only/);
  } finally { await c.close(); }
});

test('cli: deleting a thread needs --allow-deletes', async () => {
  const c = await cli();
  try {
    await c.exec('link', 'test-project', '--files', 'main.tex');
    const review = await c.reviewDir();
    const path = join(review, 'threads', 'c1.json'), thread = JSON.parse(await readFile(path, 'utf8'));
    thread.localEdits = [{ id: 'drop-c1', action: 'deleteThread' }];
    await writeFile(path, JSON.stringify(thread, null, 2));
    assert.equal((await c.exec('send', '--yes')).code, exitCodes.blocked);
    assert(c.fixture.threads.c1);
    assert.equal((await c.exec('send', '--yes', '--allow-deletes')).code, exitCodes.ok);
    assert.equal(c.fixture.threads.c1, undefined);
  } finally { await c.close(); }
});

test('cli: --take-overleaf resolves a conflict with Overleaf\'s text; without it pull stops', async () => {
  const c = await cli();
  try {
    await c.exec('link', 'test-project', '--files', 'main.tex');
    await c.exec('pull');
    // The same number changed differently on both sides, as in folderWorkflow.test.ts.
    await writeFile(join(c.root, 'main.tex'), (await readFile(join(c.root, 'main.tex'), 'utf8')).replace('0.64', '0.60'));
    c.fixture.replies.modern[0].content = c.fixture.replies.modern[0].content.replace('0.64', '0.58'); c.fixture.replies.modern[1]++;
    assert.equal((await c.exec('pull')).code, exitCodes.blocked);
    assert.match(await readFile(join(c.root, 'main.tex'), 'utf8'), /0\.60/);
    assert.equal((await c.exec('pull', '--take-overleaf')).code, exitCodes.ok);
    assert.match(await readFile(join(c.root, 'main.tex'), 'utf8'), /0\.58/);
  } finally { await c.close(); }
});

test('cli: without a session it exits with the signed-out code; unknown commands are usage errors', async () => {
  const c = await cli({ cookie: null });
  try {
    await mkdir(join(c.root, '.turnleaf'), { recursive: true });
    await c.exec('link', 'test-project', '--files', 'main.tex');
    assert.equal((await c.exec('pull')).code, exitCodes.signedOut);
    const json = await c.exec('pull', '--json');
    assert.deepEqual({ code: json.code, ...json.json(), error: undefined }, { code: 'session-expired', exitCode: exitCodes.signedOut, error: undefined });
    assert.equal((await c.exec('frobnicate')).code, exitCodes.usage);
  } finally { await c.close(); }
});

test('cli: --help and help print the usage to stdout and succeed; no command is a usage error', async () => {
  for (const argv of [['--help'], ['help'], ['send', '--help'], []]) {
    const out: string[] = [], err: string[] = [];
    const code = await run(argv, { out: line => out.push(line), err: line => err.push(line), env: {}, cwd: tmpdir() });
    const asked = argv.length > 0;
    assert.equal(code, asked ? exitCodes.ok : exitCodes.usage, argv.join(' '));
    assert.match((asked ? out : err).join('\n'), /^Usage: turnleaf/);
    assert.deepEqual(asked ? err : out, []);
  }
});

test('cli: link refuses a .turnleaf folder that is a symbolic link', async () => {
  const c = await cli(), elsewhere = await mkdtemp(join(tmpdir(), 'turnleaf-cli-elsewhere-'));
  try {
    await symlink(elsewhere, join(c.root, '.turnleaf'));
    const linked = await c.exec('link', 'test-project', '--files', 'main.tex');
    assert.equal(linked.code, exitCodes.failed);
    assert.match(linked.err, /symbolic link/);
    assert.deepEqual(await readdir(elsewhere), []);
  } finally { await c.close(); await rm(elsewhere, { recursive: true, force: true }); }
});

test('cli: a linked folder sends an unscoped cookie only to the server the caller named', async () => {
  const c = await cli();
  try {
    await c.exec('link', 'test-project', '--files', 'main.tex');
    const before = c.fixture.requests.length;
    // Another server named on the command line than the one in .turnleaf/cli.json.
    const other = await c.raw(['pull', '--folder', c.root, '--base-url', 'https://other.example']);
    assert.equal(other.code, exitCodes.usage);
    assert.match(other.err, /linked to/);
    // No server named: TURNLEAF_COOKIE and a chosen session file only go to the default server.
    assert.equal((await c.raw(['pull', '--folder', c.root])).code, exitCodes.usage);
    const file = join(c.config, 'chosen-session');
    await writeFile(file, fixtureCookie, { mode: 0o600 });
    assert.equal((await c.raw(['status', '--folder', c.root, '--session-file', file], { TURNLEAF_COOKIE: '' })).code, exitCodes.usage);
    assert.equal(c.fixture.requests.length, before, 'nothing reached the linked server');
    // Named on the command line or in TURNLEAF_BASE_URL, the linked server is used.
    assert.equal((await c.raw(['pull', '--folder', c.root, '--base-url', c.fixture.baseUrl])).code, exitCodes.ok);
    assert.equal((await c.raw(['status', '--folder', c.root], { TURNLEAF_BASE_URL: c.fixture.baseUrl })).code, exitCodes.ok);
    // The default session file belongs to one server, so the link's server needs no naming.
    const origin = createHash('sha256').update(new URL(c.fixture.baseUrl).origin).digest('hex').slice(0, 16);
    await mkdir(join(c.config, 'turnleaf'), { recursive: true });
    await writeFile(join(c.config, 'turnleaf', `session-${origin}`), fixtureCookie + '\n', { mode: 0o600 });
    const own = await c.raw(['status', '--folder', c.root], { TURNLEAF_COOKIE: '' });
    assert.equal(own.code, exitCodes.ok, own.err);
  } finally { await c.close(); }
});

test('cli: unknown options, options of another command and extra arguments are usage errors before any credential is read', async () => {
  const c = await cli({ cookie: null });
  try {
    for (const argv of [['send', '--yes', '--foler', 'other-paper'], ['projects', 'surplus'], ['pull', '--yes'], ['status', '--take-overleaf'], ['projects', '--unused=value'],
      ['projects', '--base-url', 'not a url'], ['link', 'test-project', '--files', 'figure.pdf'], ['send', '--dry-run', 'extra'], ['send', '--comments-only'], ['send', '--yes', '--dry-run']]) {
      const result = await c.raw([...argv, '--folder', c.root]);
      assert.equal(result.code, exitCodes.usage, `${argv.join(' ')}: ${result.err}`);
    }
    // With --json the refusal is a JSON object on stdout.
    const usage = await c.raw(['send', '--folder', c.root, '--json']);
    assert.deepEqual({ ...usage.json(), error: undefined }, { error: undefined, code: 'usage', exitCode: exitCodes.usage });
    assert.equal(c.fixture.requests.length, 0);
  } finally { await c.close(); }
});

const planOf = (over: Record<string, unknown>) => ({ inspection: { trackChanges: true, userId: fixtureOwner }, files: [], pending: [], comments: [], ...over }) as unknown as PushPlan;
const fileOf = (path: string, extra: Record<string, unknown> = {}) => ({ doc: { path }, text: 'Text.\n', added: 1, removed: 0, ...extra });

test('cli policy: edits need tracking with a known user, and a created file with content needs --allow-untracked-edits', () => {
  assert.deepEqual(policyProblems(planOf({ files: [fileOf('main.tex')] }), {}), []);
  // The writer tracks an edit only with Track Changes on and the account's user ID.
  assert.match(policyProblems(planOf({ inspection: { trackChanges: true }, files: [fileOf('main.tex')] }), {})[0], /Track Changes is off/);
  assert.match(policyProblems(planOf({ inspection: { trackChanges: false, userId: fixtureOwner }, files: [fileOf('main.tex')] }), {})[0], /Track Changes is off/);
  // A created file's content is always plain text, Track Changes or not.
  assert.match(policyProblems(planOf({ files: [fileOf('appendix.tex', { create: { folders: [] } })] }), {})[0], /plain text/);
  assert.deepEqual(policyProblems(planOf({ files: [fileOf('appendix.tex', { create: { folders: [] }, text: '' })] }), {}), []);
  assert.deepEqual(policyProblems(planOf({ inspection: {}, files: [fileOf('main.tex'), fileOf('appendix.tex', { create: { folders: [] } })] }), { allowUntrackedEdits: true }), []);
});

test('cli policy: --comments-only refuses accepting or rejecting suggestions', () => {
  const decision = { id: 'd1', kind: 'acceptChange', path: 'main.tex', docId: 'modern', threadId: '' }, reply = { id: 'r1', kind: 'reply', path: 'main.tex', docId: 'modern', threadId: 'c1', text: 'Done.' };
  assert.match(policyProblems(planOf({ pending: [reply, decision] }), { commentsOnly: true }).join('\n'), /suggestion decision/);
  assert.match(policyProblems(planOf({ pending: [{ ...decision, kind: 'rejectChange' }] }), { commentsOnly: true }).join('\n'), /reject in main\.tex/);
  assert.deepEqual(policyProblems(planOf({ pending: [reply] }), { commentsOnly: true }), []);
  assert.deepEqual(policyProblems(planOf({ pending: [decision] }), {}), []);
});

test('cli: creating a selected local-only file with content is refused without --allow-untracked-edits', async () => {
  const c = await cli();
  try {
    await writeFile(join(c.root, 'appendix.tex'), 'Appendix.\n');
    await c.exec('link', 'test-project', '--files', 'main.tex,appendix.tex');
    const pulled = await c.exec('pull');
    assert.equal(pulled.code, exitCodes.ok, pulled.err);
    const refused = await c.exec('send', '--yes', '--json');
    assert.equal(refused.code, exitCodes.blocked);
    assert.match(refused.json().error, /appendix\.tex on Overleaf puts the content in as plain text/);
    assert(!c.fixture.tree.docs.some((doc: { name: string }) => doc.name === 'appendix.tex'));
    const sent = await c.exec('send', '--yes', '--allow-untracked-edits');
    assert.equal(sent.code, exitCodes.ok, sent.err);
    assert(c.fixture.tree.docs.some((doc: { name: string }) => doc.name === 'appendix.tex'));
  } finally { await c.close(); }
});

test('cli: the first pull records the sync baseline even when the folder already holds Overleaf\'s text and nothing comes in', async () => {
  const c = await cli();
  try {
    c.fixture.replies.modern[0].comments = [];
    for (const id of Object.keys(c.fixture.threads)) delete c.fixture.threads[id];
    await c.exec('link', 'test-project', '--files', 'main.tex');
    await writeFile(join(c.root, 'main.tex'), c.fixture.replies.modern[0].content);
    const pulled = await c.exec('pull', '--json');
    assert.equal(pulled.code, exitCodes.ok, pulled.err);
    assert.equal(pulled.json().changed, true);
    assert.deepEqual(pulled.json().files, []);
    const status = await c.exec('status');
    assert.equal(status.code, exitCodes.ok, status.err);
    assert.equal((await c.exec('pull', '--json')).json().changed, false);
  } finally { await c.close(); }
});

test('cli: a Send with incoming changes applies them to the folder first, then sends', async () => {
  const c = await cli();
  try {
    await c.exec('link', 'test-project', '--files', 'main.tex');
    const review = await c.reviewDir();
    // A coauthor edits elsewhere in the file; a reply to c1 is queued here.
    c.fixture.replies.modern[0].content = c.fixture.replies.modern[0].content.replace('Results.', 'Results, revised.'); c.fixture.replies.modern[1]++;
    const path = join(review, 'threads', 'c1.json'), thread = JSON.parse(await readFile(path, 'utf8'));
    thread.localEdits = [{ id: 'reply-1', action: 'reply', text: 'Clarified.' }];
    await writeFile(path, JSON.stringify(thread, null, 2));
    const dry = await c.exec('send', '--dry-run', '--json');
    assert.deepEqual(dry.json().incoming, ['main.tex']);
    const sent = await c.exec('send', '--yes', '--comments-only', '--json');
    assert.equal(sent.code, exitCodes.ok, sent.err);
    assert.match(sent.err, /Applied Overleaf's changes to the folder first/);
    assert.match(await readFile(join(c.root, 'main.tex'), 'utf8'), /Results, revised\./);
    assert(c.fixture.threads.c1.messages.some((message: { content: string }) => message.content === 'Clarified.'));
    assert.equal((await c.exec('status')).code, exitCodes.ok);
  } finally { await c.close(); }
});

test('cli: exit codes follow the error code, whichever layer raised it', () => {
  assert.equal(failureOf(new SessionExpiredError()).exitCode, exitCodes.signedOut);
  // Apply and Send rethrow a new SyncError with the same code.
  assert.equal(failureOf(new SyncError('Overleaf session expired', 'session-expired')).exitCode, exitCodes.signedOut);
  assert.equal(failureOf(new SyncError('Only your own messages can be edited or deleted.', 'read-only')).exitCode, exitCodes.blocked);
  assert.equal(failureOf(new SyncError('Review file invalid.', 'review-files')).exitCode, exitCodes.blocked);
  assert.equal(failureOf(new SyncError('Unsupported response.', 'protocol')).exitCode, exitCodes.failed);
  assert.equal(failureOf(new Error('raw')).message, 'Overleaf request failed. Please try again.');
});

test('cli: session files are refused when linked, readable by others or inside the working folder; each one signs in with its own profile', async () => {
  const c = await cli();
  try {
    await c.exec('link', 'test-project', '--files', 'main.tex');
    const real = join(c.config, 'real-session'), linked = join(c.config, 'linked-session'), open = join(c.config, 'open-session');
    await writeFile(real, fixtureCookie, { mode: 0o600 }); await symlink(real, linked);
    await writeFile(open, fixtureCookie); await chmod(open, 0o644);
    const args = (file: string) => ['projects', '--base-url', c.fixture.baseUrl, '--session-file', file];
    assert.equal((await c.raw(args(real), { TURNLEAF_COOKIE: '' })).code, exitCodes.ok);
    const viaLink = await c.raw(args(linked), { TURNLEAF_COOKIE: '' });
    assert.equal(viaLink.code, exitCodes.failed); assert.match(viaLink.err, /symbolic link/);
    const readable = await c.raw(args(open), { TURNLEAF_COOKIE: '' });
    assert.equal(readable.code, exitCodes.failed); assert.match(readable.err, /others can read it/);
    const inFolder = join(c.root, 'session');
    await writeFile(inFolder, fixtureCookie, { mode: 0o600 });
    assert.equal((await c.raw(['pull', '--folder', c.root, '--base-url', c.fixture.baseUrl, '--session-file', inFolder], { TURNLEAF_COOKIE: '' })).code, exitCodes.usage);
    // The link file is private and written in one step.
    assert.equal((await stat(join(c.root, '.turnleaf', 'cli.json'))).mode & 0o777, 0o600);
    assert.deepEqual((await readdir(join(c.root, '.turnleaf'))).filter(name => name.endsWith('.tmp')), []);
  } finally { await c.close(); }
  const one = signInProfile('/config/turnleaf/a', 'https://www.overleaf.com');
  assert.equal(one.startsWith('/config/turnleaf/sign-in-'), true);
  assert.notEqual(one, signInProfile('/config/turnleaf/b', 'https://www.overleaf.com'));
  assert.notEqual(one, signInProfile('/config/turnleaf/a', 'https://overleaf.example.org'));
});

test('cli: status regenerates the review files from what it fetched', async () => {
  const c = await cli();
  try {
    await c.exec('link', 'test-project', '--files', 'main.tex');
    const review = await c.reviewDir();
    c.fixture.threads.c9 = { resolved: false, messages: [{ id: 'c9-m1', user: { id: 'reviewer', name: 'Fixture Reviewer' }, content: 'New question.', timestamp: '2026-11-27T12:00:00Z' }] };
    c.fixture.replies.modern[0].comments.push({ id: 'c9', ranges: [{ pos: 5, length: 3 }] });
    const status = await c.exec('status');
    assert.equal(status.code, exitCodes.ok, status.err);
    assert.match(await readFile(join(review, 'threads', 'c9.json'), 'utf8'), /New question\./);
  } finally { await c.close(); }
});

test('cli: pull output names pictures and the files taken from Overleaf', async () => {
  const c = await cli();
  try {
    c.fixture.addEntry('figures/plot.png', 'file', Buffer.from('fictional picture bytes'));
    await c.exec('link', 'test-project', '--files', 'main.tex');
    const first = await c.exec('pull', '--pictures', '--dry-run', '--json');
    assert.equal(first.code, exitCodes.ok, first.err);
    assert.deepEqual(first.json().pictures.map((picture: { path: string; kind: string }) => [picture.path, picture.kind]), [['figures/plot.png', 'new']]);
    await c.exec('pull');
    await writeFile(join(c.root, 'main.tex'), (await readFile(join(c.root, 'main.tex'), 'utf8')).replace('0.64', '0.60'));
    c.fixture.replies.modern[0].content = c.fixture.replies.modern[0].content.replace('0.64', '0.58'); c.fixture.replies.modern[1]++;
    const took = await c.exec('pull', '--take-overleaf', '--json');
    assert.equal(took.code, exitCodes.ok, took.err);
    assert.deepEqual(took.json().files.map((file: { path: string; tookOverleaf?: boolean }) => [file.path, file.tookOverleaf]), [['main.tex', true]]);
  } finally { await c.close(); }
});

test('cli: linking the same project with other files is refused while drafts are queued', async () => {
  const c = await cli();
  try {
    await c.exec('link', 'test-project', '--files', 'main.tex');
    const review = await c.reviewDir();
    await writeFile(join(review, 'new', 'agent-1.json'), JSON.stringify({ id: 'agent-1', path: 'main.tex', quote: 'Methods.', text: 'Sampling rate?' }));
    assert.equal((await c.exec('status')).code, exitCodes.ok);
    const relinked = await c.exec('link', 'test-project', '--files', 'main.tex,references.bib', '--json');
    assert.equal(relinked.code, exitCodes.blocked);
    assert.equal(relinked.json().code, 'selection');
    assert.deepEqual(JSON.parse(await readFile(join(c.root, '.turnleaf', 'cli.json'), 'utf8')).paths, ['main.tex']);
    assert.equal((await c.exec('link', 'test-project', '--files', 'main.tex')).code, exitCodes.ok);
  } finally { await c.close(); }
});

test('cli: a queued change of a kind Turnleaf never queues is refused, not sent', async () => {
  const c = await cli();
  try {
    await c.exec('link', 'test-project', '--files', 'main.tex');
    await c.exec('pull');
    const store = new ProjectStore(c.root, c.fixture.baseUrl, 'test-project', ['main.tex']), path = await store.path('state.json');
    const data = JSON.parse(await readFile(path, 'utf8'));
    data.pending.push({ id: 'drop', kind: 'deleteDoc', path: 'main.tex', docId: 'modern', threadId: 'c1', created: '2026-11-27T12:00:00Z' });
    await writeFile(path, JSON.stringify(data));
    const sent = await c.exec('send', '--yes', '--comments-only', '--json');
    assert.equal(sent.code, exitCodes.failed);
    assert.equal(sent.json().code, 'cache');
    assert(c.fixture.tree.docs.some((doc: { _id: string }) => doc._id === 'modern'));
  } finally { await c.close(); }
});

test('cli: a session file is never kept in a linked folder, by any path to it, also at sign-in', async () => {
  const c = await cli(), alias = join(await mkdtemp(join(tmpdir(), 'turnleaf-cli-alias-')), 'paper');
  try {
    await c.exec('link', 'test-project', '--files', 'main.tex');
    await symlink(c.root, alias);
    // No browser is started: the folder check comes first, and the browser named does not exist.
    for (const file of [join(c.root, 'session'), join(c.root, '..session'), join(alias, 'sub', 'session')]) {
      const signIn = await c.raw(['sign-in', '--base-url', c.fixture.baseUrl, '--session-file', file, '--browser', join(c.config, 'no-such-browser')], { TURNLEAF_COOKIE: '' });
      assert.equal(signIn.code, exitCodes.usage, `${file}: ${signIn.err}`);
      assert.match(signIn.err, /outside/);
    }
    await writeFile(join(c.root, '..session'), fixtureCookie, { mode: 0o600 });
    assert.equal((await c.raw(['pull', '--folder', alias, '--base-url', c.fixture.baseUrl, '--session-file', join(c.root, '..session')], { TURNLEAF_COOKIE: '' })).code, exitCodes.usage);
    // A configuration folder inside a linked folder is refused the same way.
    assert.equal((await c.raw(['projects', '--base-url', c.fixture.baseUrl], { TURNLEAF_COOKIE: '', XDG_CONFIG_HOME: join(c.root, 'config') })).code, exitCodes.usage);
  } finally { await c.close(); await rm(dirname(alias), { recursive: true, force: true }); }
});

test('cli: empty values, inherited names and an overridden bad TURNLEAF_BASE_URL are handled before any credential is read', async () => {
  const c = await cli({ cookie: null });
  try {
    for (const argv of [['send', '--yes', '--folder', ''], ['link', '', '--files', 'main.tex', '--folder', c.root], ['constructor', '--all-sources', '--folder', c.root]]) {
      const result = await c.raw(argv);
      assert.equal(result.code, exitCodes.usage, `${JSON.stringify(argv)}: ${result.err}`);
    }
    // --base-url wins over TURNLEAF_BASE_URL, so only the one used is checked (here: signed out, not a usage error).
    assert.equal((await c.raw(['projects', '--base-url', c.fixture.baseUrl], { TURNLEAF_BASE_URL: 'not a url' })).code, exitCodes.signedOut);
    // With --json, no command at all is a JSON usage error too.
    const none = await c.raw(['--json']);
    assert.equal(none.code, exitCodes.usage);
    assert.equal(none.json().code, 'usage');
  } finally { await c.close(); }
});

test('cli: --dry-run wins over --yes, status takes the Send checks, and a refused preview is a JSON error too', async () => {
  const c = await cli({ trackChanges: false });
  try {
    await c.exec('link', 'test-project', '--files', 'main.tex');
    await c.exec('pull');
    await writeFile(join(c.root, 'main.tex'), (await readFile(join(c.root, 'main.tex'), 'utf8')).replace('Methods.', 'Methods and materials.'));
    const version = c.fixture.replies.modern[1];
    const dry = await c.exec('send', '--yes', '--dry-run', '--json');
    assert.equal(dry.code, exitCodes.blocked);
    assert.equal(dry.json().dryRun, true);
    assert.equal(dry.json().code, 'policy');
    assert.equal(dry.json().exitCode, exitCodes.blocked);
    assert.match(dry.json().error, /Track Changes is off/);
    assert.equal(c.fixture.replies.modern[1], version);
    assert.equal((await c.exec('status', '--allow-untracked-edits')).code, exitCodes.ok);
    assert.equal((await c.exec('status', '--comments-only', '--allow-untracked-edits')).code, exitCodes.blocked);
  } finally { await c.close(); }
});

test('cli: relinking counts what agents saved in the review files but no command imported yet', async () => {
  const c = await cli();
  try {
    await c.exec('link', 'test-project', '--files', 'main.tex');
    const review = await c.reviewDir();
    await writeFile(join(review, 'new', 'agent-1.json'), JSON.stringify({ id: 'agent-1', path: 'main.tex', quote: 'Methods.', text: 'Sampling rate?' }));
    const relinked = await c.exec('link', 'test-project', '--files', 'main.tex,references.bib', '--json');
    assert.equal(relinked.code, exitCodes.blocked, relinked.out);
    assert.equal(relinked.json().code, 'selection');
  } finally { await c.close(); }
});

test('cli: a session that expired in the middle of Send keeps the warning about what may be on Overleaf', () => {
  const failure = failureOf(new SyncError('Overleaf session expired\nSome changes may already be remote. Get latest and inspect Sync history; uncertain comment drafts are never resent automatically.', 'session-expired'));
  assert.equal(failure.exitCode, exitCodes.signedOut);
  assert.match(failure.message, /Some changes may already be remote/);
  assert.match(failure.message, /turnleaf sign-in/);
});
