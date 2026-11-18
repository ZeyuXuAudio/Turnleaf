// Downloads the pinned, test-only Overleaf reference code into test/reference/.
//
// The tests compare the extension's own mapping with Overleaf's code, and the
// fixture server applies edits with it. That code is Overleaf's (AGPL-3.0;
// @overleaf/o-error is MIT), so it is not part of this repository: each file is
// fetched from the commit in test/reference-files.json and must match its SHA-256.
// It is never imported by the extension or included in the VSIX (scripts/build.mjs checks).
// Files already present with the right hash are kept, so later runs work offline.
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

const root = resolve('test/reference');
const manifest = JSON.parse(await readFile('test/reference-files.json', 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const present = async (path, hash) => { try { return sha256(await readFile(path)) === hash; } catch { return false; } };

let fetched = 0;
for (const file of manifest.files) {
  const target = join(root, file.path);
  if (await present(target, file.sha256)) continue;
  const url = `https://raw.githubusercontent.com/overleaf/overleaf/${manifest.commit}/${file.source}`;
  let bytes;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    console.error(`Cannot download the Overleaf reference code (${file.source}): ${error.message}\nThe tests need it once; run again with network access.`);
    process.exit(1);
  }
  if (sha256(bytes) !== file.sha256) { console.error(`${file.source} does not match its pinned SHA-256; nothing was written for it.`); process.exit(1); }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target + '.tmp', bytes); await rename(target + '.tmp', target);
  fetched++;
}
// The helper package is resolved from test/reference/node_modules by Overleaf's code.
const manifestPath = join(root, 'node_modules/@overleaf/o-error/package.json');
await writeFile(manifestPath, JSON.stringify({ name: '@overleaf/o-error', version: '3.4.0', main: 'index.cjs', license: 'MIT', repository: 'github:overleaf/o-error' }, null, 2) + '\n');
if (fetched) console.log(`Downloaded ${fetched} pinned Overleaf reference file(s) into test/reference/ (commit ${manifest.commit.slice(0, 10)}).`);
