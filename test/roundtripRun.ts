import { build } from 'esbuild';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCliLeg, type CliLegResult } from './roundtripCli';
import { newRunId, overallStatus, parseArgs, usage, UsageError, writeResult, NAME_PREFIX, type RoundtripOptions, type RunStatus, type StepRecord } from './roundtripCore';

// The live roundtrip test (`npm run test:roundtrip`, through scripts/roundtrip.mjs). It runs
// Turnleaf in VS Code against a real test project on overleaf.com, writes through Send,
// reads back and cleans up; then the same through the command line. See CONTRIBUTING.md.
//
// Order: the editor's `extension` phase (guard, link, Get latest → Apply, comment, reply,
// resolve, suggestion, cleanup), the command-line leg, and the editor's `cleanup` phase,
// which removes anything either leg left and compares the project with its state at the start.

interface PhaseResult {
  phase: string; status: string; message?: string; runtime?: object; server?: string;
  guard?: { passed: boolean; check: string; reason?: string }; trackChanges?: string; steps?: StepRecord[];
  baseline?: object | null; leftoversAtStart?: object | null; cliSessionSaved?: boolean;
  cleanup?: { completed: boolean; remaining: object | null; differences: string[] };
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let options: RoundtripOptions;
  try { options = parseArgs(argv, env); } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(error.message + '\n\n' + usage); return 2;
  }
  if (options.help) { console.log(usage); return 0; }
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY && !env.CI) && !options.noSetup && !options.fixture;
  const executable = env.TURNLEAF_EDITOR || '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
  // A durable, short path, as for test:live: later runs reuse the saved session, and the editor
  // fails to start when the IPC socket path inside --user-data-dir is too long.
  const cache = process.platform === 'darwin' ? join(homedir(), 'Library', 'Caches') : env.XDG_CACHE_HOME || join(homedir(), '.cache');
  const root = options.fixture ? await mkdtemp(join(tmpdir(), 'turnleaf-rt-')) : resolve(env.TURNLEAF_ROUNDTRIP_PROFILE || join(cache, 'turnleaf-roundtrip'));
  const profile = join(root, 'profile'), workspace = join(root, 'workspace'), cliFolder = join(root, 'cli-folder'), probe = join(root, 'probe');
  const exported = join(root, 'cli', 'session');
  if (profile.length > 80) throw new Error(`Profile path too long for the editor's IPC socket: ${profile}. Set TURNLEAF_ROUNDTRIP_PROFILE to a shorter path.`);
  if (!existsSync('dist/extension.js')) throw new Error('Run npm run build first.');
  const runId = newRunId(), startedAt = new Date();
  await mkdir(join(profile, 'User'), { recursive: true });
  await mkdir(join(root, 'results'), { recursive: true });
  const resultPath = join(root, 'results', `roundtrip-${runId}.json`);
  await writeFile(join(profile, 'User', 'settings.json'), JSON.stringify({
    'workbench.startupEditor': 'none', 'workbench.welcomePage.walkthroughs.openOnInstall': false, 'window.restoreWindows': 'none',
    'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoUpdate': false, 'window.title': '${rootName} · Turnleaf Roundtrip Test',
  }));
  // A fresh folder for each leg and run: what was sent is checked on Overleaf, not in the folder.
  for (const folder of [workspace, cliFolder]) { await rm(folder, { recursive: true, force: true }); await mkdir(folder, { recursive: true }); }
  await mkdir(join(workspace, '.vscode'));

  let fixture: Awaited<ReturnType<typeof import('./fixtureServer')['startFixtureServer']>> | undefined, fixtureCookie: string | undefined;
  if (options.fixture) {
    const server = await import('./fixtureServer');
    // TURNLEAF_ROUNDTRIP_FIXTURE_NAME renames the fixture project, to see the name guard refuse it.
    fixture = await server.startFixtureServer({ writable: true, projectName: env.TURNLEAF_ROUNDTRIP_FIXTURE_NAME ?? `${NAME_PREFIX} – fixture` });
    fixtureCookie = server.fixtureCookie;
  }
  const baseUrl = fixture?.baseUrl ?? 'https://www.overleaf.com';
  await writeFile(join(workspace, '.vscode', 'settings.json'), JSON.stringify(fixture ? { 'turnleaf.baseUrl': baseUrl } : {}, null, 2) + '\n');
  if (options.extension) await build({ entryPoints: ['test/roundtripProbe.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node18', outfile: join(probe, 'extension.js'), external: ['vscode'], logLevel: 'error' });
  await writeFile(join(probe, 'package.json'), JSON.stringify({
    name: 'turnleaf-roundtrip-probe', publisher: 'local-turnleaf', version: '0.0.0', private: true,
    engines: { vscode: '^1.80.0' }, activationEvents: ['onStartupFinished'], main: './extension.js',
  }, null, 2));
  if (options.cli) {
    const built = spawnSync(process.execPath, ['scripts/build-cli.mjs'], { stdio: 'inherit' });
    if (built.status !== 0) throw new Error('npm run build:cli failed.');
  }
  console.log(`Roundtrip profile: ${root}\nRun ${runId}; result: ${resultPath}`);

  let current: (() => Promise<void>) | undefined;
  const removeExported = () => rm(exported, { force: true });
  for (const name of ['SIGINT', 'SIGTERM'] as const) process.on(name, async () => { await current?.(); await removeExported(); process.exit(1); });

  async function phase(name: 'setup' | 'extension' | 'cleanup', extra: Record<string, string> = {}): Promise<PhaseResult | undefined> {
    const path = join(root, 'results', `${runId}-${name}.json`);
    await rm(path, { force: true });
    const childEnv: NodeJS.ProcessEnv = { ...env, TURNLEAF_LIVE_PROBE: '1', TURNLEAF_ROUNDTRIP: '1', TURNLEAF_ROUNDTRIP_PHASE: name, TURNLEAF_ROUNDTRIP_RESULT: path,
      TURNLEAF_ROUNDTRIP_WORKSPACE: workspace, TURNLEAF_ROUNDTRIP_PROJECT: options.project!, TURNLEAF_ROUNDTRIP_RUN: runId,
      ...fixtureCookie && { TURNLEAF_ROUNDTRIP_FIXTURE_COOKIE: fixtureCookie }, ...extra };
    delete childEnv.ELECTRON_RUN_AS_NODE; delete childEnv.VSCODE_IPC_HOOK_CLI;
    if (name === 'setup') console.log('In the editor window, run Turnleaf: Sign In. The window closes when you are signed in.');
    // A process group, so that the whole editor can be closed.
    const child = spawn(executable, [workspace, '--new-window', `--user-data-dir=${profile}`, `--extensions-dir=${join(root, 'extensions')}`,
      `--extensionDevelopmentPath=${resolve('.')}`, `--extensionDevelopmentPath=${probe}`,
      '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'], { env: childEnv, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '', exited = false, spawnError: Error | undefined;
    child.stderr!.on('data', chunk => { stderr = (stderr + chunk).slice(-10_000); });
    const exit = new Promise<void>(done => {
      child.on('exit', () => { exited = true; done(); });
      child.on('error', error => { spawnError = error; exited = true; done(); });
    });
    const signal = (kind: NodeJS.Signals) => { try { process.kill(-child.pid!, kind); } catch { /* already closed */ } };
    current = async () => {
      if (exited) return;
      signal('SIGTERM');
      const timer = setTimeout(() => signal('SIGKILL'), 5_000);
      await exit; clearTimeout(timer);
    };
    const deadline = Date.now() + { setup: 20, extension: 12, cleanup: 8 }[name] * 60_000;
    while (!exited && !existsSync(path) && Date.now() < deadline) await new Promise(done => setTimeout(done, 500));
    // Give the editor time to persist the saved session before it is closed.
    if (name === 'setup' && existsSync(path)) await new Promise(done => setTimeout(done, 3_000));
    await current();
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch {
      console.error(spawnError?.message ?? (Date.now() >= deadline ? `The ${name} phase timed out without a result.` : `The editor closed without a result. Is another editor already using ${profile}?`));
      if (stderr && !options.fixture) console.error(stderr.split('\n').filter(line => !/cookie|session/i.test(line)).slice(-20).join('\n'));
      return undefined;
    }
  }

  const steps: StepRecord[] = [];
  let stop: RunStatus | undefined, message: string | undefined, guard: PhaseResult['guard'], trackChanges: string | undefined, runtime: object | undefined;
  let ext: PhaseResult | undefined, cliResult: CliLegResult | undefined, final: PhaseResult | undefined, secrets: string[] = [];
  const failed = (leg: StepRecord['leg'], name: string, error: string) => steps.push({ leg, name, outcome: 'failed', durationMs: 0, error });
  try {
    if (options.extension) {
      let setupDone = false;
      if (options.setup) {
        setupDone = true;
        const setup = await phase('setup');
        if (setup?.status !== 'ready') stop = 'setup-required';
      }
      if (!stop) {
        ext = await phase('extension', options.cli && !options.sessionFile ? { TURNLEAF_ROUNDTRIP_CLI_SESSION: exported } : {});
        if (ext && ['setup-required', 'session-expired'].includes(ext.status) && !setupDone) {
          if (interactive) {
            console.log(`The extension phase reported ${ext.status}; opening the sign-in window.`);
            const setup = await phase('setup');
            if (setup?.status === 'ready') ext = await phase('extension', options.cli && !options.sessionFile ? { TURNLEAF_ROUNDTRIP_CLI_SESSION: exported } : {});
          } else console.error(`The extension phase reported ${ext.status}. Run npm run test:roundtrip -- --setup in a terminal to sign in.`);
        }
      }
      if (!stop && !ext) { stop = 'failed'; failed('runner', 'extension-phase', 'The editor gave no result.'); }
      if (ext) {
        runtime = ext.runtime; guard = ext.guard; trackChanges = ext.trackChanges; steps.push(...ext.steps ?? []);
        if (['setup-required', 'session-expired', 'refused'].includes(ext.status)) stop = ext.status as RunStatus;
        else if (ext.status === 'failed') { message = ext.message; failed('extension', 'extension-phase', ext.message ?? 'failed'); }
      }
    }
    const linked = !!ext?.steps?.some(step => step.name === 'link' && step.outcome === 'passed');
    if (options.cli && !stop) {
      const sessionFile = fixtureCookie ? join(root, 'cli', 'fixture-session') : options.sessionFile ? resolve(options.sessionFile) : ext?.cliSessionSaved ? exported : undefined;
      if (fixtureCookie) { await mkdir(join(root, 'cli'), { recursive: true }); await writeFile(sessionFile!, fixtureCookie + '\n', { mode: 0o600 }); }
      if (!sessionFile) steps.push({ leg: 'cli', name: 'cli-session', outcome: 'skipped', durationMs: 0, reason: 'no-session: the extension leg did not reach the point where it saves one' });
      else {
        cliResult = await runCliLeg({ cli: resolve('dist/cli.js'), folder: cliFolder, sessionFile, baseUrl, projectId: options.project!, runId });
        secrets = cliResult.secrets;
        steps.push(...cliResult.steps);
        if (!options.extension) guard = cliResult.guard;
        if (cliResult.status === 'refused') stop = 'refused';
        else if (cliResult.status === 'session-expired') { if (!options.extension) stop = 'session-expired'; else failed('cli', 'cli-session', cliResult.message ?? 'The command-line session was not accepted.'); }
        else if (cliResult.status === 'failed') failed('cli', 'cli-leg', cliResult.message ?? 'failed');
      }
    }
    // The final cleanup and end check, whenever the extension leg linked the folder (and so may have written).
    if (options.extension && linked && stop !== 'refused') {
      final = await phase('cleanup', ext?.baseline ? { TURNLEAF_ROUNDTRIP_BASELINE: JSON.stringify(ext.baseline) } : {});
      if (!final) failed('runner', 'final-cleanup', 'The editor gave no result for the final cleanup.');
      else { steps.push(...final.steps ?? []); if (final.status !== 'done') failed('runner', 'final-cleanup', `${final.status}${final.message ? `: ${final.message}` : ''}`); }
    }
  } catch (error) {
    message = error instanceof Error ? error.message : 'The runner failed.';
    failed('runner', 'runner', message);
  } finally {
    await removeExported();
  }

  // Cleanup is complete when the last check that ran found the project as it started.
  const cleanup = options.extension
    ? final?.cleanup ?? (ext && !ext.steps?.some(step => step.name === 'link') ? { completed: true, remaining: null, differences: [] } : { completed: false, remaining: null, differences: [] })
    : cliResult?.cleanup ?? { completed: false, remaining: null, differences: [] };
  const status = overallStatus({ guardPassed: guard?.passed, steps, cleanupCompleted: cleanup.completed, stop });
  const finishedAt = new Date();
  const result = {
    test: 'live-roundtrip-test', runId, status, startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), durationMs: finishedAt.getTime() - startedAt.getTime(),
    server: new URL(baseUrl).origin, fixture: fixture ? { writes: fixtureWrites(fixture.requests) } : false, legs: { extension: options.extension, cli: options.cli },
    runtime: runtime ?? null, guard: guard ?? null, trackChanges: trackChanges ?? null,
    counts: { passed: steps.filter(s => s.outcome === 'passed').length, failed: steps.filter(s => s.outcome === 'failed').length, skipped: steps.filter(s => s.outcome === 'skipped').length },
    steps,
    cleanup: { completed: cleanup.completed, remaining: cleanup.remaining, differences: cleanup.differences, leftoversAtStart: ext?.leftoversAtStart ?? null,
      extensionLeg: ext?.cleanup ?? null, cliLeg: cliResult?.cleanup ?? null },
    cli: cliResult ? { status: cliResult.status, commands: cliResult.commands, cookie: cliResult.cookie, sessionSource: fixtureCookie ? 'fixture' : options.sessionFile ? 'session-file' : 'editor-profile' } : null,
    ...message && { message },
  };
  await writeResult(resultPath, result, secrets);
  for (const step of steps) console.log(`${step.outcome.padEnd(7)} ${step.leg.padEnd(9)} ${step.name.padEnd(36)} ${String(step.durationMs).padStart(6)} ms${step.error ? `  ${step.error}` : step.reason ? `  (${step.reason})` : ''}`);
  console.log(`\n${status}${guard && !guard.passed ? ` — refused: ${guard.reason}` : ''}; cleanup ${cleanup.completed ? 'completed' : 'NOT completed'}${cleanup.differences.length ? ` (${cleanup.differences.join('; ')})` : ''}.\nResult: ${resultPath}`);
  await fixture?.close();
  if (fixtureCookie) await rm(join(root, 'cli', 'fixture-session'), { force: true });
  return status === 'passed' ? 0 : 1;
}

/** Requests that wrote to the fixture: anything but reads and the socket's session control (connect, heartbeat, joinDoc, leaveDoc). */
function fixtureWrites(requests: { method: string; path: string; packet?: string }[]): number {
  return requests.filter(request => {
    if (request.method === 'GET') return false;
    if (request.method !== 'POST' || !request.path.startsWith('/socket.io/1/xhr-polling/')) return true;
    if (['0::', '2::'].includes(request.packet ?? '')) return false;
    const match = /^5:\d+\+::(.+)$/.exec(request.packet ?? '');
    try { return !match || !['joinDoc', 'leaveDoc'].includes(JSON.parse(match[1]).name); } catch { return true; }
  }).length;
}
