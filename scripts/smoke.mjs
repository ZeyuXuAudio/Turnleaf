import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// VS Code by default; TURNLEAF_EDITOR selects another VS Code or Electron executable, such as Cursor.
const executable = process.env.TURNLEAF_EDITOR || '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
// `--press` runs test/pressDrive.ts instead: it presses the panel's buttons with mouse input through the editor's
// DevTools port, opened on a free local port for this run only.
const press = process.argv.includes('--press');
const tests = press ? { entry: 'test/pressDrive.ts', out: 'dist/press-test.js' } : { entry: 'test/extensionSmoke.ts', out: 'dist/smoke-test.js' };
const port = press ? await new Promise(done => { const server = createServer().listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => done(port)); }); }) : 0;
const root = await mkdtemp(join(tmpdir(), 'turnleaf-host-'));
const workspace = join(root, 'workspace');
await mkdir(join(workspace, '.vscode'), { recursive: true });
await mkdir(join(root, 'profile', 'User'), { recursive: true });
await writeFile(join(workspace, 'main.tex'), 'Local text remains unchanged during inspection.\n');
await writeFile(join(workspace, '.vscode/settings.json'), '{}\n');
await writeFile(join(root, 'profile', 'User', 'settings.json'), JSON.stringify({
  'workbench.startupEditor': 'none', 'workbench.welcomePage.walkthroughs.openOnInstall': false,
  'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoUpdate': false,
  'window.title': 'Turnleaf Smoke Test',
}));
await build({ entryPoints: [tests.entry], bundle: true, platform: 'node', format: 'cjs', target: 'node18', outfile: tests.out, external: ['vscode'] });
const resultPath = join(root, 'result.json');
const env = { ...process.env, TURNLEAF_SMOKE_RESULT: resultPath, TURNLEAF_SMOKE_HOLD: process.argv.includes('--hold') ? '1' : '0', TURNLEAF_PRESS_PORT: String(port) };
delete env.ELECTRON_RUN_AS_NODE;
delete env.VSCODE_IPC_HOOK_CLI;
console.log(`Isolated test workspace: ${workspace}\nResults: ${resultPath}`);
const child = spawn(executable, [workspace, '--new-window', `--user-data-dir=${join(root, 'profile')}`, `--extensions-dir=${join(root, 'extensions')}`,
  `--extensionDevelopmentPath=${resolve('.')}`, `--extensionTestsPath=${resolve(tests.out)}`, ...(press ? [`--remote-debugging-port=${port}`] : []),
  '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-10_000); });
const timer = setTimeout(() => child.kill(), 7 * 60_000);
child.on('error', error => { console.error(error.message); clearTimeout(timer); process.exitCode = 1; });
child.on('exit', async code => {
  clearTimeout(timer);
  try {
    const result = JSON.parse(await readFile(resultPath, 'utf8'));
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = code === 0 && result.status === 'passed' ? 0 : 1;
  } catch { console.error(stderr); process.exitCode = 1; }
});
