import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// Options: --setup forces the sign-in window first; --no-setup never opens it; --recent N and
// project IDs or names (positional, or TURNLEAF_LIVE_PROJECTS, comma-separated) add Q2 projects;
// --files a,b (or TURNLEAF_LIVE_FILES) sets the files read in those projects.
const args = process.argv.slice(2), selectors = [], options = {};
for (let i = 0; i < args.length; i++) {
  if (['--recent', '--files'].includes(args[i])) options[args[i].slice(2)] = args[++i];
  else if (args[i].startsWith('--')) options[args[i].slice(2)] = true;
  else selectors.push(args[i]);
}
const list = value => (value ?? '').split(',').map(item => item.trim()).filter(Boolean);
selectors.push(...list(process.env.TURNLEAF_LIVE_PROJECTS));
const recent = Number(options.recent ?? process.env.TURNLEAF_LIVE_RECENT ?? 0);
const files = list(typeof options.files === 'string' ? options.files : process.env.TURNLEAF_LIVE_FILES);
if (!Number.isSafeInteger(recent) || recent < 0) throw new Error('--recent takes a whole number.');
// The sign-in window opens by itself only when someone is at the terminal to use it.
const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY && !process.env.CI) && !options['no-setup'];
const executable = process.env.TURNLEAF_EDITOR || '/Applications/Cursor.app/Contents/MacOS/Cursor';

// A durable, short path: later runs reuse the saved session, macOS purges $TMPDIR after a few
// days of disuse, and Cursor fails to start (`listen EINVAL`) when the IPC socket path inside
// --user-data-dir is too long.
const cache = process.platform === 'darwin' ? join(homedir(), 'Library', 'Caches') : process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
const root = resolve(process.env.TURNLEAF_LIVE_PROFILE || join(cache, 'turnleaf-live'));
const profile = join(root, 'profile'), workspace = join(root, 'workspace'), probe = join(root, 'probe'), statePath = join(root, 'session.json');
if (profile.length > 80) throw new Error(`Profile path too long for the editor's IPC socket: ${profile}. Set TURNLEAF_LIVE_PROFILE to a shorter path.`);
if (!existsSync('dist/extension.js')) throw new Error('Run npm run build first.');
await mkdir(join(profile, 'User'), { recursive: true });
await mkdir(join(workspace, '.vscode'), { recursive: true });
await mkdir(join(root, 'results'), { recursive: true });
await writeFile(join(profile, 'User', 'settings.json'), JSON.stringify({
  'workbench.startupEditor': 'none', 'workbench.welcomePage.walkthroughs.openOnInstall': false, 'window.restoreWindows': 'none',
  'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoUpdate': false, 'window.title': '${rootName} · Turnleaf Live Probe',
}));
// Workspace settings keep the linked project between runs; only the server address is set here.
const settingsPath = join(workspace, '.vscode', 'settings.json');
let settings = {};
try { settings = JSON.parse(await readFile(settingsPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw new Error(`Fix or remove ${settingsPath}.`); }
if (process.env.TURNLEAF_LIVE_BASE_URL) settings['turnleaf.baseUrl'] = process.env.TURNLEAF_LIVE_BASE_URL;
await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n');
await build({ entryPoints: ['test/liveProbe.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node18', outfile: join(probe, 'extension.js'), external: ['vscode'] });
await writeFile(join(probe, 'package.json'), JSON.stringify({
  name: 'turnleaf-live-probe', publisher: 'local-turnleaf', version: '0.0.0', private: true,
  engines: { vscode: '^1.80.0' }, activationEvents: ['onStartupFinished'], main: './extension.js',
}, null, 2));
console.log(`Live probe profile: ${root}`);

let current;
for (const name of ['SIGINT', 'SIGTERM']) process.on(name, async () => { await current?.(); process.exit(1); });

async function run(phase) {
  // Setup changes are deliberate. Each inspection restores the settings it started
  // with, including a project selected in the preceding setup phase.
  const savedSettings = phase === 'inspect' ? await readFile(settingsPath, 'utf8') : undefined;
  const resultPath = join(root, 'results', `${phase}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const env = { ...process.env, TURNLEAF_LIVE_PROBE: '1', TURNLEAF_LIVE_PHASE: phase, TURNLEAF_LIVE_RESULT: resultPath,
    TURNLEAF_LIVE_WORKSPACE: workspace, TURNLEAF_LIVE_PROJECT_LIST: JSON.stringify(selectors), TURNLEAF_LIVE_RECENT: String(recent),
    ...files.length && { TURNLEAF_LIVE_FILE_LIST: JSON.stringify(files) } };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VSCODE_IPC_HOOK_CLI;
  console.log(`Result: ${resultPath}`);
  if (phase === 'setup') console.log('In the editor window, run Turnleaf: Sign In (and Turnleaf: Link Project if asked). The window closes when done.');
  // A process group, so the whole editor can be closed: workbench.action.quit does not close Cursor 3.
  const child = spawn(executable, [workspace, '--new-window', `--user-data-dir=${profile}`, `--extensions-dir=${join(root, 'extensions')}`,
    `--extensionDevelopmentPath=${resolve('.')}`, `--extensionDevelopmentPath=${probe}`,
    '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'], { env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '', exited = false, spawnError;
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-10_000); });
  const exit = new Promise(resolve => {
    child.on('exit', () => { exited = true; resolve(); });
    child.on('error', error => { spawnError = error; exited = true; resolve(); });
  });
  const signal = name => { try { process.kill(-child.pid, name); } catch { /* already closed */ } };
  current = async () => {
    if (!exited) {
      signal('SIGTERM');
      const timer = setTimeout(() => signal('SIGKILL'), 5_000);
      await exit;
      clearTimeout(timer);
    }
    // Also restore after a failed or interrupted inspection.
    if (savedSettings !== undefined) await writeFile(settingsPath, savedSettings);
  };
  const deadline = Date.now() + (phase === 'setup' ? 20 : 5 + selectors.length + recent) * 60_000;
  while (!exited && !existsSync(resultPath) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 500));
  // Give the editor time to persist the saved session before it is closed.
  if (phase === 'setup' && existsSync(resultPath)) await new Promise(resolve => setTimeout(resolve, 3_000));
  await current();
  try { return { path: resultPath, result: JSON.parse(await readFile(resultPath, 'utf8')) }; }
  catch {
    console.error(spawnError?.message ?? (Date.now() >= deadline ? 'Timed out without a result.' : 'The editor closed without a result. Is another editor already using this profile?'));
    if (stderr) console.error(stderr);
    return undefined;
  }
}

// Q7: session.json keeps, per server, when the saved session was signed in, first and last
// accepted, and first rejected. It holds timestamps only; the cookie stays in the profile.
async function loadState() {
  let state = {};
  try { state = JSON.parse(await readFile(statePath, 'utf8')); } catch { /* first run */ }
  if (typeof state.server === 'string') state = { [state.server]: { signedInAt: state.signedInAt } };
  return state;
}
async function earlierRuns(server, exclude) {
  const times = [];
  for (const name of (await readdir(join(root, 'results'))).filter(name => name.startsWith('inspect-') && join(root, 'results', name) !== exclude).sort()) {
    try {
      const result = JSON.parse(await readFile(join(root, 'results', name), 'utf8'));
      if (result.server === server && result.session?.accepted === true) times.push(result.finishedAt);
    } catch { /* unreadable or partial */ }
  }
  return times.length ? { firstAcceptedAt: times[0], lastAcceptedAt: times.at(-1), seededFromResults: true } : {};
}
const hours = (from, to) => from && to ? Math.round((Date.parse(to) - Date.parse(from)) / 36_000) / 100 : undefined;

async function record(phase, outcome) {
  const { result, path } = outcome, server = result.server, state = await loadState();
  if (phase === 'setup') {
    if (result.status !== 'ready') return;
    const previous = state[server];
    state[server] = { signedInAt: result.session?.signedInAt, history: [...previous?.history ?? [], ...previous ? [{ ...previous, history: undefined }] : []] };
  } else {
    // A session saved before this file existed is dated by the earlier accepted results.
    const entry = state[server] ??= await earlierRuns(server, path);
    const { accepted } = result.session ?? {}, at = result.finishedAt, since = entry.signedInAt ?? entry.firstAcceptedAt;
    result.session = { ...result.session, signedInAt: entry.signedInAt ?? null, firstAcceptedAt: entry.firstAcceptedAt ?? null,
      lastAcceptedAt: entry.lastAcceptedAt ?? null, ageHours: hours(since, at) ?? null };
    if (accepted === true) {
      entry.firstAcceptedAt ??= at;
      entry.lastAcceptedAt = at;
      delete entry.rejectedAt;
      result.session.lifetimeHours = { since: entry.signedInAt ? 'signedInAt' : 'firstAcceptedAt', atLeast: hours(since, at) ?? 0 };
    } else if (accepted === false) {
      entry.rejectedAt ??= at;
      result.session.rejectedAt = entry.rejectedAt;
      result.session.lifetimeHours = { since: entry.signedInAt ? 'signedInAt' : 'firstAcceptedAt',
        atLeast: hours(since, entry.lastAcceptedAt) ?? null, atMost: entry.signedInAt ? hours(entry.signedInAt, entry.rejectedAt) : null };
    }
    await writeFile(path, JSON.stringify(result, null, 2) + '\n');
  }
  await writeFile(statePath, JSON.stringify(state, null, 2) + '\n');
}

let last, setupDone = false;
for (const phase of options.setup ? ['setup', 'inspect'] : ['inspect']) {
  if (phase === 'setup') setupDone = true;
  last = await run(phase);
  if (!last) break;
  await record(phase, last);
  if (phase === 'setup' && last.result.status !== 'ready') break;
}
if (last?.result.phase === 'inspect' && ['setup-required', 'session-expired'].includes(last.result.status) && !setupDone) {
  if (interactive) {
    console.log(`Inspect reported ${last.result.status}; opening the sign-in window.`);
    last = await run('setup');
    if (last) await record('setup', last);
    if (last?.result.status === 'ready') { last = await run('inspect'); if (last) await record('inspect', last); }
  } else console.error(`Inspect reported ${last.result.status}. Run npm run test:live -- --setup in a terminal to sign in again.`);
}
if (last) console.log(JSON.stringify(last.result, null, 2));
process.exitCode = last?.result.phase === 'inspect' && last.result.status === 'passed' ? 0 : 1;
