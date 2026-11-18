import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const repo = resolve(__dirname, '../..');

async function workspace() {
  // Short paths avoid the live runner's editor IPC path limit. The mock executable
  // uses a POSIX shebang, like the supported macOS/Linux editor launchers.
  const root = await mkdtemp('/tmp/ols-runner-');
  const checkout = join(root, 'repo');
  await mkdir(join(checkout, 'dist'), { recursive: true });
  for (const name of ['scripts', 'src', 'test']) await symlink(join(repo, name), join(checkout, name), 'dir');
  // The simulated editor never loads the extension; no prebuilt bundle is required.
  await writeFile(join(checkout, 'dist', 'extension.js'), '');
  return { root, checkout };
}

function run(script: string, args: string[], cwd: string, overrides: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env = { ...process.env };
  // Tests cannot inherit real accounts, profiles, project selectors or CE servers.
  for (const key of Object.keys(env)) if (/^(OVERLEAF_(SYNC_|CE_)|TURNLEAF_)/.test(key)) delete env[key];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(repo, 'scripts', script), ...args], { cwd, env: { ...env, ...overrides }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('exit', code => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
  });
}

test('live setup persists its project and later inspections restore that new baseline', { skip: process.platform === 'win32' }, async () => {
  const { root, checkout } = await workspace();
  try {
    const editor = join(root, 'editor.cjs'), profile = join(root, 'live');
    const settingsPath = join(profile, 'workspace', '.vscode', 'settings.json');
    await writeFile(editor, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const env = process.env;
const file = path.join(env.TURNLEAF_LIVE_WORKSPACE, '.vscode', 'settings.json');
const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
const setup = env.TURNLEAF_LIVE_PHASE === 'setup';
const linked = settings['turnleaf.projectId'] === 'chosen-project';
if (setup) {
  settings['turnleaf.projectId'] = 'chosen-project';
  settings['turnleaf.trackedFiles'] = ['chosen.tex'];
} else {
  settings['turnleaf.projectId'] = 'temporary-probe-project';
  settings['turnleaf.trackedFiles'] = ['temporary.tex'];
}
fs.writeFileSync(file, JSON.stringify(settings));
if (env.TURNLEAF_TEST_NO_RESULT) process.exit(1);
fs.writeFileSync(env.TURNLEAF_LIVE_RESULT, JSON.stringify({
  phase: env.TURNLEAF_LIVE_PHASE, server: 'https://example.test',
  status: setup ? 'ready' : linked ? 'passed' : 'setup-required',
  session: setup ? { signedInAt: new Date().toISOString() } : { accepted: linked },
  finishedAt: new Date().toISOString()
}));
`);
    await chmod(editor, 0o700);
    const env = { TURNLEAF_EDITOR: editor, TURNLEAF_LIVE_PROFILE: profile };
    const setup = await run('live.mjs', ['--setup'], checkout, env);
    assert.equal(setup.code, 0, setup.stdout + setup.stderr);
    const expected = { 'turnleaf.projectId': 'chosen-project', 'turnleaf.trackedFiles': ['chosen.tex'] };
    assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), expected);
    const inspect = await run('live.mjs', ['--no-setup'], checkout, env);
    assert.equal(inspect.code, 0, inspect.stdout + inspect.stderr);
    assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), expected);
    const failed = await run('live.mjs', ['--no-setup'], checkout, { ...env, TURNLEAF_TEST_NO_RESULT: '1' });
    assert.equal(failed.code, 1);
    assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), expected, 'restore even when the editor exits without a result');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('CE runner cleans up partially seeded projects and reports cleanup failures', { skip: process.platform === 'win32' }, async () => {
  const { root, checkout } = await workspace();
  const projectId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
  let created = 0, deleted = 0, rejectDelete = false;
  const server = createServer((req, res) => {
    if (req.url === '/launchpad') { res.writeHead(302, { Location: '/login' }).end(); return; }
    if (req.url === '/login' && req.method === 'POST') { res.setHeader('Set-Cookie', 'overleaf_session2=fictional-cookie; Path=/'); res.end('{}'); return; }
    if (req.url === '/login') { res.end('<meta name="ol-csrfToken" content="fictional-csrf">'); return; }
    if (req.url === '/project') { res.end('<meta name="ol-csrfToken" content="fictional-csrf"><meta name="ol-user_id" content="aaaaaaaaaaaaaaaaaaaaaaaa">'); return; }
    if (req.url === '/project/new') { created++; res.end(JSON.stringify({ project_id: projectId })); return; }
    if (req.url?.startsWith('/socket.io/')) { res.writeHead(503).end('Injected seeding failure'); return; }
    if (req.method === 'DELETE' && req.url === '/project/' + projectId) { deleted++; res.writeHead(rejectDelete ? 503 : 200).end('{}'); return; }
    res.writeHead(404).end();
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const mode of ['cleanup', 'keep', 'failed-cleanup']) {
      rejectDelete = mode === 'failed-cleanup';
      const home = join(root, mode), before = deleted;
      const outcome = await run('ce.mjs', ['--no-editor', ...mode === 'keep' ? ['--keep'] : []], checkout, {
        OVERLEAF_CE_URL: baseUrl, OVERLEAF_CE_HOME: home, OVERLEAF_CE_PASSWORD: 'fictional-password',
      });
      assert.equal(outcome.code, 1, 'the injected seeding failure must fail the run');
      const files = await readdir(join(home, 'results'));
      const result = JSON.parse(await readFile(join(home, 'results', files[0]), 'utf8'));
      assert.equal(result.status, 'failed');
      assert.equal(result.projects.length, 0, 'failure happened before seeding completed');
      assert.match(result.errors[0].message, /Injected seeding failure/);
      assert.equal(deleted - before, mode === 'keep' ? 0 : 1, 'delete the project even though it was never fully seeded, unless --keep is set');
      assert.equal(result.errors.some((error: { step: string }) => error.step === 'delete project'), rejectDelete);
    }
    assert.equal(created, 3);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
