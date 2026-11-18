import { build } from 'esbuild';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
const editor = process.env.TURNLEAF_EDITOR || '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
const app = dirname(dirname(editor)), cli = join(app, 'Resources/app/bin', editor.includes('Cursor.app') ? 'cursor' : 'code');
const root = await mkdtemp(join(tmpdir(), 'turnleaf-installed-')), workspace = join(root, 'workspace'), profile = join(root, 'profile'), extensions = join(root, 'extensions'), driver = join(root, 'driver'), result = join(root, 'result.json');
await mkdir(workspace); await mkdir(driver); await mkdir(join(profile, 'User'), { recursive: true });
await writeFile(join(profile, 'User/settings.json'), JSON.stringify({ 'workbench.startupEditor': 'none', 'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoUpdate': false, 'window.title': 'Turnleaf Installed Test' }));
await build({ entryPoints: ['test/fixtureServer.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node18', outfile: join(driver, 'fixture.cjs') });
const fixture = await createRequire(import.meta.url)(join(driver, 'fixture.cjs')).startFixtureServer();
const env = { ...process.env, TURNLEAF_SMOKE_RESULT: result, TURNLEAF_INSTALLED_BASE_URL: fixture.baseUrl, TURNLEAF_INSTALLED_INTERACTIVE: '1' }; delete env.ELECTRON_RUN_AS_NODE; delete env.VSCODE_IPC_HOOK_CLI;
async function launch(developmentPath, tests) {
  await new Promise((done, reject) => {
    const child = spawn(editor, [workspace, '--new-window', `--user-data-dir=${profile}`, `--extensions-dir=${extensions}`, `--extensionDevelopmentPath=${developmentPath}`, `--extensionTestsPath=${tests}`, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.on('data', c => { stderr = (stderr + c).slice(-3000); });
    const timer = setTimeout(() => child.kill(), 120_000);
    child.on('exit', code => { clearTimeout(timer); code === 0 ? done() : reject(new Error(stderr || `Editor exited ${code}`)); });
    child.on('error', e => { clearTimeout(timer); reject(e); });
  });
}
try {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const install = spawnSync(cli, ['--user-data-dir', profile, '--extensions-dir', extensions, '--install-extension', resolve(`releases/${pkg.name}-${pkg.version}.vsix`), '--force'], { env, encoding: 'utf8', timeout: 60_000 });
  if (install.status !== 0) throw new Error(install.stderr || install.stdout || install.error?.message);
  const installed = (await readdir(extensions)).filter(n => n.startsWith('zeyuxu.turnleaf-'));
  if (installed.length !== 1) throw new Error('Could not identify the installed VSIX.');
  await writeFile(join(driver, 'package.json'), JSON.stringify({ name: 'overleaf-installed-test-driver', publisher: 'local-test', version: '0.0.1', engines: { vscode: '^1.80.0' }, main: './index.js', extensionDependencies: ['zeyuxu.turnleaf'] }));
  await writeFile(join(driver, 'index.js'), 'exports.activate = () => {};');
  for (const [entry, output] of [['installedSmoke', 'test.js']]) await build({ entryPoints: [`test/${entry}.ts`], bundle: true, platform: 'node', format: 'cjs', target: 'node18', outfile: join(driver, output), external: ['vscode'] });
  console.log(`Installed VSIX in an isolated profile. Result: ${result}`);
  {
    await mkdir(join(workspace, '.vscode'), { recursive: true });
    await writeFile(join(workspace, '.vscode/settings.json'), JSON.stringify({ 'turnleaf.baseUrl': fixture.baseUrl, 'turnleaf.projectId': 'test-project', 'turnleaf.trackedFiles': ['main.tex', 'references.bib'] }));
    console.log('Enter fictional-fixture-session in the isolated VS Code sign-in prompt.');
  }
  await launch(driver, join(driver, 'test.js'));
  const r = JSON.parse(await readFile(result, 'utf8')); console.log(JSON.stringify(r, null, 2));
  if (r.status !== 'passed') process.exitCode = 1;
} catch (error) { console.error(error.message); try { console.error(await readFile(result, 'utf8')); } catch {} process.exitCode = 1; }
finally { await fixture.close(); }
