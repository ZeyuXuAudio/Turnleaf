import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

// npm run test:roundtrip: the live roundtrip test. It writes to a real Overleaf project whose
// name starts with "Turnleaf test", then removes what it wrote. The runner is TypeScript
// (test/roundtripRun.ts), bundled here and run; `-- --help` lists its options.
const outfile = resolve('dist/roundtrip-runner.js');
await build({ entryPoints: ['test/roundtripRun.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node18', outfile, external: ['esbuild'], logLevel: 'error' });
const { main } = createRequire(import.meta.url)(outfile);
process.exitCode = await main(process.argv.slice(2));
