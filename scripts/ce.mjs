import { build } from 'esbuild';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Unattended live test against a throwaway Overleaf Community Edition instance in Docker.
// See CONTRIBUTING.md. Run `npm run test:ce -- --help` for the options.
const options = {
  '--dry-run': 'print the plan and check prerequisites; start nothing',
  '--keep': 'keep the containers, data and seeded projects for the next run',
  '--down': 'stop and remove kept containers and data, then exit',
  '--no-editor': "inspect with the extension's reader in Node instead of the editor",
  '--no-shim': 'point the extension at CE directly, without the threads shim',
  '--sharejs-only': 'skip the history-ot project',
  '--sync': 'also test Pull, dry run, guarded uploads and verification on the disposable projects',
  '--binary': 'also probe non-text files (tree fields, download, upload, delete, linked files, size limit) on the disposable projects',
};
const flags = new Set(process.argv.slice(2));
if (flags.has('--help')) { console.log(Object.entries(options).map(([flag, text]) => `  ${flag.padEnd(16)}${text}`).join('\n')); process.exit(0); }
const unknown = [...flags].filter(flag => !(flag in options));
if (unknown.length) throw new Error(`Unknown option ${unknown.join(', ')}. Run npm run test:ce -- --help.`);
const has = flag => flags.has(flag);
const editor = process.env.TURNLEAF_EDITOR || '/Applications/Cursor.app/Contents/MacOS/Cursor';
// Container data, credentials and results live in a git-ignored directory of this checkout.
const home = resolve(process.env.OVERLEAF_CE_HOME || '.overleaf-ce');
const port = process.env.OVERLEAF_CE_PORT || '8090';
const external = process.env.OVERLEAF_CE_URL;
const baseUrl = (external || `http://localhost:${port}`).replace(/\/+$/, '');
const composeFile = resolve('scripts/overleaf-ce/docker-compose.yml');
const image = /image:\s*(sharelatex\/sharelatex:\S+)/.exec(readFileSync(composeFile, 'utf8'))?.[1];
const credentialsPath = join(home, 'credentials.env');
const log = text => console.error(`[test:ce] ${text}`);
const message = error => error instanceof Error ? error.message : String(error);

async function readCredentials() {
  try {
    return Object.fromEntries((await readFile(credentialsPath, 'utf8')).split('\n').filter(Boolean).map(line => line.split(/=(.*)/s).slice(0, 2)));
  } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}
/** Generated per instance and kept only in the git-ignored home, so a kept instance can be reused. */
async function credentials() {
  const saved = await readCredentials();
  const values = {
    OVERLEAF_CE_EMAIL: process.env.OVERLEAF_CE_EMAIL || saved.OVERLEAF_CE_EMAIL || 'turnleaf-admin@example.test',
    OVERLEAF_CE_PASSWORD: process.env.OVERLEAF_CE_PASSWORD || saved.OVERLEAF_CE_PASSWORD || randomBytes(18).toString('base64url'),
    OVERLEAF_CE_INVITE_SECRET: saved.OVERLEAF_CE_INVITE_SECRET || randomBytes(32).toString('base64url'),
  };
  await mkdir(home, { recursive: true });
  await writeFile(credentialsPath, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''), { mode: 0o600 });
  return values;
}

let composeEnv = { ...process.env, OVERLEAF_CE_DATA: join(home, 'data'), OVERLEAF_CE_PORT: port, OVERLEAF_CE_SITE_URL: baseUrl, OVERLEAF_CE_INVITE_SECRET: 'unset' };
const compose = (...args) => ['compose', '-p', 'turnleaf-ce', '-f', composeFile, ...args];
function docker(args, { inherit = false, check = true } = {}) {
  const result = spawnSync('docker', args, { env: composeEnv, encoding: 'utf8', stdio: inherit ? 'inherit' : 'pipe', maxBuffer: 64 * 1024 * 1024 });
  if (check && result.status !== 0) {
    const detail = (result.stderr || result.error?.message || '').trim().slice(-500);
    throw new Error(`docker ${args.slice(0, 6).join(' ')}… failed${detail ? `: ${detail}` : ''}`);
  }
  return result;
}
function dockerStatus() {
  const version = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' });
  if (version.error) return { installed: false, running: false };
  const composeVersion = spawnSync('docker', ['compose', 'version', '--short'], { encoding: 'utf8' });
  return { installed: true, running: version.status === 0, engine: version.stdout.trim() || undefined, compose: composeVersion.status === 0 ? composeVersion.stdout.trim() : undefined };
}

// Reaches CE services that have no public route (see Backend in test/ce/harness.ts).
const fetchScript = "const [m,u,b]=process.argv.slice(1);fetch(u,{method:m,headers:{'Content-Type':'application/json'},body:b||undefined})" +
  ".then(async r=>{const t=await r.text();if(!r.ok){console.error('HTTP '+r.status+' '+t.slice(0,200));process.exit(1)}process.stdout.write(t)})" +
  '.catch(e=>{console.error(e.message);process.exit(1)})';
const internal = (method, url, body) => docker(compose('exec', '-T', 'sharelatex', 'node', '-e', fetchScript, method, url, body ? JSON.stringify(body) : '')).stdout;
const dockerBackend = {
  name: 'docker compose exec',
  // The chat service (port 3010) holds comment threads; CE has no public route to it.
  postMessage: async (projectId, threadId, userId, content) => { internal('POST', `http://127.0.0.1:3010/project/${projectId}/thread/${threadId}/messages`, { user_id: userId, content }); },
  resolveThread: async (projectId, _docId, threadId, userId) => { internal('POST', `http://127.0.0.1:3010/project/${projectId}/thread/${threadId}/resolve`, { user_id: userId }); },
  threads: async projectId => internal('GET', `http://127.0.0.1:3010/project/${projectId}/threads`),
  migrateToHistoryOT: async projectId => {
    // Flush the docs out of the document updater, then raise the project's OT migration stage
    // as HistoryOTMigration.advanceOTMigrationStage would; the next load converts the docs.
    internal('DELETE', `http://127.0.0.1:3003/project/${projectId}`);
    const matched = docker(compose('exec', '-T', 'mongo', 'mongosh', '--quiet', 'mongodb://127.0.0.1/sharelatex', '--eval',
      `db.projects.updateOne({ _id: ObjectId("${projectId}") }, { $max: { "overleaf.history.otMigrationStage": 1 } }).matchedCount`)).stdout.trim();
    if (matched !== '1') throw new Error(`Setting otMigrationStage matched ${matched || 'no'} project.`);
  },
};

async function teardown() {
  if (external) return 'external instance left running';
  docker(compose('down', '--volumes', '--remove-orphans'), { inherit: true });
  // On Linux the data directory holds root-owned files; remove them from a container.
  if (existsSync(join(home, 'data'))) docker(['run', '--rm', '-v', `${home}:/home-dir`, '--entrypoint', 'rm', image, '-rf', '/home-dir/data'], { check: false });
  await rm(join(home, 'data'), { recursive: true, force: true });
  await rm(credentialsPath, { force: true });
  return 'containers, data and credentials removed';
}

const require = createRequire(import.meta.url);
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['test/ce/harness.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node18', outfile: 'dist/ce-harness.cjs', logLevel: 'error' });
await build({ entryPoints: ['test/ce/probe.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node18', outfile: 'dist/ce-probe.js', external: ['vscode'], logLevel: 'error' });
const harness = require(resolve('dist/ce-harness.cjs'));
if (has('--binary')) await build({ entryPoints: ['test/ce/binaryProbe.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node18', outfile: 'dist/ce-binary.cjs', logLevel: 'error' });
if (has('--sync')) await build({ entryPoints: ['test/ce/syncProbe.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node18', outfile: 'dist/ce-sync.cjs', logLevel: 'error' });
const projectTypes = has('--sharejs-only') || external ? ['sharejs-text-ot'] : ['sharejs-text-ot', 'history-ot'];

if (has('--dry-run')) {
  const status = dockerStatus();
  console.log(JSON.stringify({
    probe: 'turnleaf-ce', status: 'dry-run',
    docker: status, image, composeFile, home, server: baseUrl, external: Boolean(external),
    editor: { path: editor, exists: existsSync(editor), used: !has('--no-editor') },
    steps: [
      external ? `use the running instance at ${baseUrl}` : `docker ${compose('up', '--detach', '--wait').join(' ')}`,
      `wait for ${baseUrl}/login`,
      'register the admin through /launchpad on a fresh instance (generated password in credentials.env)',
      'log in: GET /login for the CSRF token, POST /login; keep only the overleaf_session2 cookie',
      ...projectTypes.map(type => `create a ${type} project, upload main.tex, references.bib and range-cases.tex, seed threads and tracked changes`),
      has('--no-shim') || external ? 'inspect against CE directly' : 'start the threads shim (CE has no GET /project/:id/threads)',
      has('--no-editor') ? "inspect with the extension's reader in Node" : 'sign in through the extension in a temporary editor profile and inspect each project',
      has('--keep') ? 'keep the projects and containers' : external ? 'delete the projects' : 'delete the projects, remove the containers, data and credentials',
    ],
    seedPerProject: Object.fromEntries(projectTypes.map(type => [type, harness.planSummary(type)])),
  }, null, 2));
  if (!status.installed) log('Docker is not installed. A real run needs Docker Desktop (or another engine with Compose v2), or OVERLEAF_CE_URL.');
  process.exit(0);
}

if (has('--down')) {
  if (external) throw new Error('--down manages only the local containers; unset OVERLEAF_CE_URL.');
  composeEnv.OVERLEAF_CE_INVITE_SECRET = (await readCredentials()).OVERLEAF_CE_INVITE_SECRET || 'unset';
  log(await teardown());
  process.exit(0);
}

const started = new Date();
const result = { probe: 'turnleaf-ce', status: 'failed', startedAt: started.toISOString(), server: baseUrl, ce: {}, protocol: {}, projects: [], errors: [] };
const seeded = [];
const createdProjectIds = [];
let session, shim, tempRoot, interrupted = false;
const cleanupTemp = async () => { if (tempRoot) await rm(tempRoot, { recursive: true, force: true }).catch(() => {}); tempRoot = undefined; };
for (const name of ['SIGINT', 'SIGTERM']) process.on(name, async () => { interrupted = true; await cleanupTemp(); process.exit(1); });

try {
  const account = await credentials();
  composeEnv = { ...composeEnv, OVERLEAF_CE_INVITE_SECRET: account.OVERLEAF_CE_INVITE_SECRET };
  if (!external) {
    const status = dockerStatus();
    if (!status.installed) throw new Error('Docker is not installed. Install Docker Desktop (or another engine with Compose v2), set OVERLEAF_CE_URL to an existing instance, or run with --dry-run.');
    if (!status.running) throw new Error('The Docker engine is not running. Start Docker Desktop and retry.');
    if (!status.compose) throw new Error('Docker Compose v2 (`docker compose`) is not available.');
    result.ce = { image, dockerEngine: status.engine, compose: status.compose };
    await mkdir(join(home, 'data'), { recursive: true });
    log(`Starting ${image} on ${baseUrl}. The first start pulls about 1.5 GB and, on Apple Silicon, runs the amd64 image under emulation.`);
    docker(compose('up', '--detach', '--wait', '--wait-timeout', '600'), { inherit: true });
  } else result.ce = { external: true };
  result.ce.readySeconds = Math.round(await harness.waitForServer(baseUrl, 10 * 60_000) / 1000);
  const admin = await harness.ensureAdmin(baseUrl, account.OVERLEAF_CE_EMAIL, account.OVERLEAF_CE_PASSWORD);
  log(admin === 'registered' ? 'Registered the test admin through /launchpad.' : 'The test admin already exists.');
  const loggedIn = await harness.login(baseUrl, account.OVERLEAF_CE_EMAIL, account.OVERLEAF_CE_PASSWORD);
  session = loggedIn.session;
  const info = await harness.serverInfo(session);
  result.ce = { ...result.ce, appName: info.appName, sessionCookies: loggedIn.cookieNames, projectListMeta: info.projectListMeta };
  const backend = external ? harness.webBackend(session) : dockerBackend;

  for (const type of projectTypes) {
    log(`Seeding a throwaway ${type} project.`);
    const project = await harness.seedProject(session, backend, info.userId, type, id => createdProjectIds.push(id));
    seeded.push(project.project);
    result.projects.push({ label: type, seeded: harness.seedSummary(project.project.expectations), harnessJoinDoc: project.otTypes, joinProject: project.joinProject });
  }
  // The extension reads GET /project/:id/threads first; CE has no such route.
  const threadsRoute = await harness.threadsStatus(session, seeded[0].projectId);
  const useShim = threadsRoute !== 200 && !has('--no-shim') && Boolean(backend.threads);
  result.protocol = { threadsRouteStatus: threadsRoute, threadsShim: useShim };
  if (useShim) shim = await harness.startThreadsShim(baseUrl, backend);
  const extensionUrl = shim?.url ?? baseUrl;
  const cookie = harness.sessionCookie(session);

  let inspected;
  if (has('--no-editor')) inspected = await harness.inspectWithReader(extensionUrl, cookie, seeded);
  else {
    if (!existsSync(editor)) throw new Error(`Editor not found at ${editor}. Set TURNLEAF_EDITOR or use --no-editor.`);
    // A short path: Cursor fails to start when the IPC socket path in --user-data-dir is long.
    tempRoot = await mkdtemp(join(tmpdir(), 'turnleaf-ce-'));
    const workspace = join(tempRoot, 'workspace'), profile = join(tempRoot, 'profile');
    await mkdir(join(workspace, '.vscode'), { recursive: true });
    await mkdir(join(profile, 'User'), { recursive: true });
    await writeFile(join(profile, 'User', 'settings.json'), JSON.stringify({
      'workbench.startupEditor': 'none', 'workbench.welcomePage.walkthroughs.openOnInstall': false, 'window.restoreWindows': 'none',
      'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoUpdate': false, 'window.title': 'Turnleaf CE Test',
    }));
    await writeFile(join(workspace, '.vscode', 'settings.json'), JSON.stringify({ 'turnleaf.baseUrl': extensionUrl, 'turnleaf.projectId': seeded[0].projectId }, null, 2) + '\n');
    // The throwaway account's cookie reaches the editor only through this file, which the
    // probe deletes after reading; the whole temporary directory is removed afterwards.
    const cookieFile = join(tempRoot, 'cookie'), expectFile = join(tempRoot, 'expected.json'), resultFile = join(tempRoot, 'result.json');
    await writeFile(cookieFile, cookie, { mode: 0o600 });
    await writeFile(expectFile, JSON.stringify(seeded));
    const env = { ...process.env, TURNLEAF_CE_COOKIE_FILE: cookieFile, TURNLEAF_CE_EXPECT: expectFile, TURNLEAF_CE_RESULT: resultFile };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.VSCODE_IPC_HOOK_CLI;
    log('Running the extension in a temporary editor profile.');
    const child = spawn(editor, [workspace, '--new-window', `--user-data-dir=${profile}`, `--extensions-dir=${join(tempRoot, 'extensions')}`,
      `--extensionDevelopmentPath=${resolve('.')}`, `--extensionTestsPath=${resolve('dist/ce-probe.js')}`,
      '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'], { env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-10_000); });
    const exited = new Promise(done => { child.on('exit', done); child.on('error', error => { stderr += error.message; done(); }); });
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* closed */ } }, 7 * 60_000);
    await exited;
    clearTimeout(timer);
    try { inspected = JSON.parse(await readFile(resultFile, 'utf8')); }
    catch { result.errors.push({ step: 'editor', code: 'no-result', message: 'The editor closed without a result.', stderr: stderr.slice(-2_000) }); }
  }
  if (inspected) {
    const { projects = [], errors = [], ...rest } = inspected;
    Object.assign(result, rest);
    result.errors.push(...errors);
    for (const project of projects) Object.assign(result.projects.find(entry => entry.label === project.label) ?? {}, project);
  }
  if (shim) result.protocol.threadsServedByShim = shim.served;
  if (has('--sync')) {
    log('Testing Pull and guarded uploads on the disposable projects.');
    result.sync = await require(resolve('dist/ce-sync.cjs')).syncProbe(extensionUrl, cookie, seeded);
    if (!external) {
      log('Testing uploads with Track Changes enabled on the disposable projects.');
      for (const project of seeded) {
        const script = `db.projects.updateOne({ _id: ObjectId("${project.projectId}") }, { $set: { track_changes: { "${info.userId}": true } } }).matchedCount`;
        if (docker(compose('exec', '-T', 'mongo', 'mongosh', '--quiet', 'mongodb://127.0.0.1/sharelatex', '--eval', script)).stdout.trim() !== '1') throw new Error('Could not enable Track Changes in the disposable project.');
      }
      result.syncTracked = await require(resolve('dist/ce-sync.cjs')).syncProbe(extensionUrl, cookie, seeded, true);
    }
  }
  if (has('--binary')) {
    log('Probing non-text files on the disposable projects.');
    result.binary = await require(resolve('dist/ce-binary.cjs')).binaryProbe(baseUrl, session, seeded);
  }
} catch (error) {
  result.errors.push({ step: 'harness', code: 'harness', message: message(error) });
  if (error instanceof Error && error.stack) process.stderr.write(`[test:ce] ${error.stack}\n`);
} finally {
  await cleanupTemp();
  await shim?.close();
  if (!interrupted) {
    try {
      if (has('--keep')) result.teardown = `kept at ${baseUrl}; credentials in ${credentialsPath}; remove with npm run test:ce -- --down`;
      else {
        for (const projectId of createdProjectIds) {
          try { await harness.deleteProject(session, projectId); }
          catch (error) { result.errors.push({ step: 'delete project', code: 'teardown', message: message(error) }); }
        }
        result.teardown = await teardown();
      }
    } catch (error) { result.errors.push({ step: 'teardown', code: 'teardown', message: message(error) }); }
  }
}
const docs = result.projects.flatMap(project => (project.inspection?.docs ?? []).map(doc => [`${project.label} project: ${doc.path}`, doc.otType]));
result.otTypes = Object.fromEntries(docs);
result.otTypeNote = harness.otTypeNote([...docs.map(([, type]) => type), ...result.projects.flatMap(project => Object.values(project.harnessJoinDoc ?? {}).map(item => item.after ?? item.before))]);
result.finishedAt = new Date().toISOString();
result.durationSeconds = Math.round((Date.now() - started.getTime()) / 1000);
const inspectedAll = result.projects.length === projectTypes.length && result.projects.every(project => project.inspection && !project.positionProblems?.length);
const editorChecks = has('--no-editor') || (result.cookieInSettings === false && result.signOutClearedSecret === true);
result.status = !result.errors.length && result.session?.accepted && inspectedAll && editorChecks ? 'passed' : 'failed';
await mkdir(join(home, 'results'), { recursive: true });
const resultPath = join(home, 'results', `ce-${started.toISOString().replace(/[:.]/g, '-')}.json`);
await writeFile(resultPath, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
log(`Result: ${resultPath}`);
process.exitCode = result.status === 'passed' ? 0 : 1;
