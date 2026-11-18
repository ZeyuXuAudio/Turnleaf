import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const executable = process.env.TURNLEAF_EDITOR || '/Applications/Cursor.app/Contents/MacOS/Cursor';
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
await build({ entryPoints: ['test/extensionSmoke.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node18', outfile: 'dist/smoke-test.js', external: ['vscode'] });
const resultPath = join(root, 'result.json');
const env = { ...process.env, TURNLEAF_SMOKE_RESULT: resultPath, TURNLEAF_SMOKE_HOLD: process.argv.includes('--hold') ? '1' : '0' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.VSCODE_IPC_HOOK_CLI;
console.log(`Isolated test workspace: ${workspace}\nResults: ${resultPath}`);
const child = spawn(executable, [workspace, '--new-window', `--user-data-dir=${join(root, 'profile')}`, `--extensions-dir=${join(root, 'extensions')}`,
  `--extensionDevelopmentPath=${resolve('.')}`, `--extensionTestsPath=${resolve('dist/smoke-test.js')}`,
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
