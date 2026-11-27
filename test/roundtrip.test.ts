import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fixtureCookie, startFixtureServer } from './fixtureServer';
import {
  commentQuote, leftovers, markers, nameGuard, newRunId, nothingLeft, overallStatus, parseArgs, projectState, stateDifferences,
  Steps, StepFailure, UsageError, withEditLine, writeResult, MARKER_PREFIX,
} from './roundtripCore';
import { runCliLeg } from './roundtripCli';
import type { Inspection } from '../src/core/models';

// Offline checks of the live roundtrip test (npm run test:roundtrip): its arguments, the name
// guard, the result file, and the command-line leg against the local fixture server.
const id = '0123456789abcdef01234567';

test('roundtrip arguments: project from --project or the environment, legs and options', () => {
  assert.deepEqual(parseArgs(['--project', id]), { setup: false, noSetup: false, extension: true, cli: true, fixture: false, help: false, project: id, sessionFile: undefined });
  assert.equal(parseArgs([`--project=${id}`]).project, id);
  assert.equal(parseArgs([], { TURNLEAF_ROUNDTRIP_PROJECT: ` ${id} ` }).project, id);
  assert.equal(parseArgs(['--project', id], { TURNLEAF_ROUNDTRIP_PROJECT: 'ffffffffffffffffffffffff' }).project, id, '--project wins over the environment');
  assert.equal(parseArgs(['--project', id, '--no-cli']).cli, false);
  assert.equal(parseArgs(['--project', id, '--no-cli', '--cli']).cli, true);
  assert.equal(parseArgs(['--project', id, '--setup']).setup, true);
  assert.equal(parseArgs(['--project', id, '--session-file', 'f']).sessionFile, 'f');
  assert.equal(parseArgs(['--project', id], { TURNLEAF_ROUNDTRIP_SESSION_FILE: 'g' }).sessionFile, 'g');
  assert.equal(parseArgs(['--project', id, '--no-extension', '--session-file', 'f']).extension, false);
  assert.equal(parseArgs(['--fixture']).project, 'test-project');
  assert.equal(parseArgs(['--help']).help, true, 'help needs no project');
  assert.equal(parseArgs(['--setup']).project, undefined, '--setup alone only signs in');
  assert.equal(parseArgs(['--setup'], { TURNLEAF_ROUNDTRIP_PROJECT: id }).project, id);
  for (const [argv, message] of [
    [[], /--project ID/], [['--setup', '--no-extension', '--session-file', 'f'], /--project ID/], [['--project'], /needs a value/], [['--project', '--setup'], /needs a value/], [['--project', 'my-paper'], /24-character/],
    [['--project', id, '--frobnicate'], /Unknown option/], [[id], /Unexpected argument/], [['--project', id, '--setup=yes'], /takes no value/],
    [['--project', id, '--setup', '--no-setup'], /not both/], [['--project', id, '--no-extension', '--no-cli'], /nothing to run/],
    [['--project', id, '--no-extension'], /needs --session-file/],
  ] as [string[], RegExp][]) assert.throws(() => parseArgs(argv), (error: Error) => error instanceof UsageError && message.test(error.message), argv.join(' '));
});

test('roundtrip name guard: only a listed project named "Turnleaf test…" with the same name on its page', () => {
  const projects = [{ id, name: 'Turnleaf test – roundtrip' }, { id: 'ffffffffffffffffffffffff', name: 'My real paper' }];
  assert.deepEqual(nameGuard(id, projects), { passed: true, check: 'project name starts with "Turnleaf test"' });
  assert.equal(nameGuard(id, projects, 'Turnleaf test – roundtrip').passed, true);
  assert.equal(nameGuard('ffffffffffffffffffffffff', projects).reason, 'name-does-not-match');
  assert.equal(nameGuard('aaaaaaaaaaaaaaaaaaaaaaaa', projects).reason, 'not-in-project-list');
  assert.equal(nameGuard(id, projects, 'My real paper').reason, 'names-differ');
  for (const name of ['turnleaf test – roundtrip', ' Turnleaf test', 'Paper (Turnleaf test)', 'Turnleaf tes']) assert.equal(nameGuard(id, [{ id, name }]).passed, false, name);
  assert(!JSON.stringify(nameGuard('ffffffffffffffffffffffff', projects)).includes('real paper'), 'A refused name is never recorded');
});

const inspection = (text: string, extra: Partial<Inspection> = {}): Inspection => ({
  projectId: id, projectName: 'Turnleaf test', fetchedAt: '', missingFiles: [], unassignedThreadCount: 0, threads: {},
  docs: [{ path: 'main.tex', docId: 'd', otType: 'history-ot', version: 1, text, comments: [], changes: [], diagnostics: [] }], ...extra,
});

test('roundtrip markers, leftovers and the start-to-end comparison', () => {
  const runId = newRunId(new Date('2026-11-27T19:05:06.789Z'));
  assert.match(runId, /^20261127T190506Z-[0-9a-f]{4}$/);
  const m = markers(runId, 'cli');
  assert(m.comment.startsWith(`${MARKER_PREFIX} ${runId} cli`) && m.reply.startsWith(MARKER_PREFIX) && m.edit.startsWith(`% ${MARKER_PREFIX}`));
  assert.match(m.id, /^[\w-]{1,128}$/);
  const text = '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n';
  assert.equal(commentQuote(text), '\\documentclass{article}');
  assert.equal(commentQuote('short\nshort\n'), undefined);
  assert.equal(commentQuote('repeated line\nrepeated line\n'), undefined);
  assert.equal(withEditLine(text, m.edit), `${text}${m.edit}\n`);
  assert.equal(withEditLine('no newline', m.edit), `no newline\n${m.edit}`);
  const clean = inspection(text);
  assert(nothingLeft(leftovers(clean)));
  const edited = withEditLine(text, m.edit);
  const left = inspection(edited, { threads: { t1: { id: 't1', resolved: true, messages: [{ author: 'x', text: m.comment }, { author: 'x', text: m.reply }] }, t2: { id: 't2', resolved: false, messages: [{ author: 'x', text: 'A real comment.' }] } } });
  left.docs[0].changes.push({ id: 's1', kind: 'insert', pos: text.length, text: m.edit + '\n', author: 'x' });
  assert.deepEqual(leftovers(left), { threads: ['t1'], suggestions: [{ path: 'main.tex', id: 's1' }], directText: [] });
  left.docs[0].changes = [];
  assert.deepEqual(leftovers(left).directText, ['main.tex'], 'A marker in the text without a suggestion is a direct change');
  const before = projectState(clean), after = projectState(left);
  assert.deepEqual(stateDifferences(before, before), []);
  assert.deepEqual(stateDifferences(before, after), ['main.tex: text differs', 'threads total: 0 → 2', 'threads resolved: 0 → 1', 'threads messages: 0 → 3']);
  assert(!JSON.stringify(after).includes('documentclass'), 'The state holds hashes and counts, no text');
});

test('roundtrip steps, status and result file', async () => {
  const steps = new Steps('extension');
  assert.equal(await steps.run('ok', async () => ({ value: 7, detail: { rows: 1 } })), 7);
  assert.equal(await steps.run('bad', async () => { throw new StepFailure('Send: blocked', { exitCode: 3 }); }), undefined);
  steps.skip('suggestion-edit', 'track-changes-off');
  assert.deepEqual(steps.list.map(step => [step.name, step.outcome, step.error ?? step.reason ?? null]), [['ok', 'passed', null], ['bad', 'failed', 'Send: blocked'], ['suggestion-edit', 'skipped', 'track-changes-off']]);
  assert.equal(steps.list[1].detail?.exitCode, 3);
  const passed = [steps.list[0]];
  assert.equal(overallStatus({ guardPassed: true, steps: passed, cleanupCompleted: true }), 'passed');
  assert.equal(overallStatus({ guardPassed: true, steps: passed, cleanupCompleted: false }), 'failed', 'An incomplete cleanup fails the run');
  assert.equal(overallStatus({ guardPassed: true, steps: [steps.list[0], steps.list[2]], cleanupCompleted: true }), 'incomplete', 'A skipped step is not a pass');
  assert.equal(overallStatus({ guardPassed: true, steps: steps.list, cleanupCompleted: true }), 'failed');
  assert.equal(overallStatus({ guardPassed: false, steps: [], cleanupCompleted: true }), 'refused');
  assert.equal(overallStatus({ guardPassed: undefined, steps: [], cleanupCompleted: true }), 'failed', 'No guard result is no pass');
  assert.equal(overallStatus({ steps: [], cleanupCompleted: false, stop: 'setup-required' }), 'setup-required');
  const dir = await mkdtemp(join(tmpdir(), 'turnleaf-roundtrip-result-')), path = join(dir, 'result.json');
  const secret = 's%3Aa-session-cookie-value.signature';
  await writeResult(path, { status: 'failed', steps: steps.list, message: `oops ${secret}` }, [secret, undefined, 'short']);
  const written = await readFile(path, 'utf8');
  assert(!written.includes(secret) && written.includes('[redacted]'), 'A secret never reaches the result');
  assert.equal(JSON.parse(written).steps.length, 3);
  assert(!existsSync(path + '.partial'));
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('roundtrip command-line leg: refused for a project not named "Turnleaf test…", with no write', async () => {
  const cli = buildCli(), fixture = await startFixtureServer({ writable: true });
  try {
    const dir = await mkdtemp(join(tmpdir(), 'turnleaf-roundtrip-cli-')), sessionFile = join(dir, 'session');
    await writeFile(sessionFile, fixtureCookie + '\n', { mode: 0o600 });
    const result = await runCliLeg({ cli, folder: join(dir, 'folder'), sessionFile, baseUrl: fixture.baseUrl, projectId: 'test-project', runId: newRunId() });
    assert.equal(result.status, 'refused');
    assert.equal(result.guard?.reason, 'name-does-not-match');
    assert.deepEqual(result.commands, [], 'No CLI command runs before the guard passes');
    assert.equal(fixture.requests.filter(request => request.method !== 'GET' && !request.path.startsWith('/socket.io/')).length, 0, 'Nothing is written');
  } finally { await fixture.close(); }
});

test('roundtrip command-line leg against the fixture server: comment, reply, resolve and cleanup', async () => {
  const cli = buildCli(), fixture = await startFixtureServer({ writable: true, projectName: 'Turnleaf test – fixture' });
  try {
    const dir = await mkdtemp(join(tmpdir(), 'turnleaf-roundtrip-cli-')), sessionFile = join(dir, 'session');
    await writeFile(sessionFile, fixtureCookie + '\n', { mode: 0o600 });
    const threadsBefore = JSON.stringify(fixture.threads);
    const result = await runCliLeg({ cli, folder: join(dir, 'folder'), sessionFile, baseUrl: fixture.baseUrl, projectId: 'test-project', runId: newRunId() });
    const summary = result.steps.map(step => `${step.name}: ${step.outcome}${step.error ? ` (${step.error})` : ''}`);
    assert.equal(result.status, 'done', result.message);
    assert.deepEqual(result.steps.map(step => [step.name, step.outcome]), [
      ['cli-link', 'passed'], ['cli-pull', 'passed'], ['cli-status', 'passed'], ['cli-comment-new', 'passed'], ['cli-comment-reply', 'passed'],
      ['cli-comment-resolve', 'passed'], ['cli-cleanup-delete-thread', 'passed'], ['cli-cleanup-verify', 'passed']], summary.join('\n'));
    assert.equal(result.cleanup.completed, true);
    assert.equal(JSON.stringify(fixture.threads), threadsBefore, 'The fixture ends with the threads it started with');
    assert.deepEqual(result.cookie, { savedByCli: false, seenByReader: false, commandsThatRenewed: [] }, 'The fixture never renews the cookie');
    assert(result.commands.every(command => !command.command.includes(fixtureCookie)));
  } finally { await fixture.close(); }
});

function buildCli(): string {
  const built = spawnSync(process.execPath, ['scripts/build-cli.mjs'], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  return resolve('dist/cli.js');
}
