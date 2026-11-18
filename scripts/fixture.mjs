import { build } from 'esbuild';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

await build({ entryPoints: ['test/fixtureServer.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node18', outfile: 'dist/fixture-server.cjs' });
const { startFixtureServer, fixtureCookie } = createRequire(import.meta.url)(resolve('dist/fixture-server.cjs'));
const fixture = await startFixtureServer();
const workspace = await mkdtemp(join(tmpdir(), 'turnleaf-ui-'));
await mkdir(join(workspace, '.vscode'));
await writeFile(join(workspace, '.vscode/settings.json'), JSON.stringify({
  'turnleaf.baseUrl': fixture.baseUrl, 'turnleaf.projectId': 'test-project', 'turnleaf.trackedFiles': ['main.tex', 'references.bib'],
  'window.title': 'Turnleaf UI Test',
}, null, 2));
await writeFile(join(workspace, 'main.tex'), 'This local file must stay unchanged during inspection.\n');
console.log(JSON.stringify({ workspace, baseUrl: fixture.baseUrl, fictionalCookie: fixtureCookie }, null, 2));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await fixture.close(); process.exit(0); });
