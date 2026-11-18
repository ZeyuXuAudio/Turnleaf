import { build } from 'esbuild';
import { mkdir, readFile, readdir, writeFile, copyFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
const result = await build({ entryPoints: ['src/extension/extension.ts'], bundle: true, platform: 'node', format: 'cjs',
  target: 'node18', outfile: 'dist/extension.js', external: ['vscode'], metafile: true, sourcemap: false,
  banner: { js: '/* Turnleaf. Includes MIT-licensed adaptations from olcli; see THIRD_PARTY_NOTICES.md. */' } });
const worker = await build({ entryPoints: ['src/core/reviewWorker.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node18', outfile: 'dist/review-worker.js', metafile: true });
Object.assign(result.metafile.inputs, worker.metafile.inputs);
if (Object.keys(result.metafile.inputs).some(path => /(?:^|\/)conf\//.test(path) || path.endsWith('/config.js'))) {
  throw new Error('A credential configuration store entered the extension bundle.');
}
if (Object.keys(result.metafile.inputs).some(path => path.includes('test/reference/'))) throw new Error('Test-only reference code entered the extension bundle.');
for (const output of [...Object.values(result.metafile.outputs), ...Object.values(worker.metafile.outputs)]) {
  if (['src/core/git.ts', 'src/core/sync.ts', 'src/core/workflow.ts'].some(path => output.inputs[path]?.bytesInOutput)) throw new Error('Legacy Git sync code entered the extension bundle.');
}
await writeFile('dist/metafile.json', JSON.stringify(result.metafile, null, 2));
for (const file of ['pdf.mjs', 'pdf.worker.mjs']) await copyFile(`node_modules/pdfjs-dist/legacy/build/${file}`, `dist/${file}`);
const roots = new Set(Object.keys(result.metafile.inputs).filter(path => path.includes('node_modules/')).map(path => {
  const start = path.lastIndexOf('node_modules/') + 'node_modules/'.length;
  const parts = path.slice(start).split('/');
  return path.slice(0, start) + parts.slice(0, parts[0].startsWith('@') ? 2 : 1).join('/');
}));
roots.add('node_modules/pdfjs-dist');
const mit = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.`;
// Code that a bundled package carries inside itself, under its own license.
const embedded = {
  // The fork credits its upstream only in a README, which the package files leave out.
  '@pdf-lib/standard-fonts': `#### afm (font metrics and encodings, forked from https://github.com/chbrown/afm)

Copyright 2015–2018 Christopher Brown. Licensed under the MIT license:

${mit}

#### base64-arraybuffer (ported in @pdf-lib/standard-fonts/lib/utils.js)

Copyright (c) 2012 Niklas von Hertzen. Licensed under the MIT license, whose text appears
under afm above.`,
  'pako': `#### zlib 1.2.8 (ported in pako/lib/zlib)

(C) 1995-2013 Jean-loup Gailly and Mark Adler
(C) 2014-2017 Vitaly Puzrin and Andrei Tuputcyn

This software is provided 'as-is', without any express or implied
warranty. In no event will the authors be held liable for any damages
arising from the use of this software.

Permission is granted to anyone to use this software for any purpose,
including commercial applications, and to alter it and redistribute it
freely, subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not
  claim that you wrote the original software. If you use this software
  in a product, an acknowledgment in the product documentation would be
  appreciated but is not required.
2. Altered source versions must be plainly marked as such, and must not be
  misrepresented as being the original software.
3. This notice may not be removed or altered from any source distribution.`,
  'pdfjs-dist': `#### core-js 3.38.1 (polyfills inside pdf.mjs and pdf.worker.mjs)

Copyright (c) 2014-2024 Denis Pushkarev

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

#### OpenJPEG (WebAssembly JPEG 2000 decoder inside pdf.worker.mjs)

Copyright (c) 2002-2014, Universite catholique de Louvain (UCL), Belgium
Copyright (c) 2002-2014, Professor Benoit Macq
Copyright (c) 2003-2014, Antonin Descampe
Copyright (c) 2003-2009, Francois-Olivier Devaux
Copyright (c) 2005, Herve Drolon, FreeImage Team
Copyright (c) 2002-2003, Yannick Verschueren
Copyright (c) 2001-2003, David Janssens
Copyright (c) 2011-2012, Centre National d'Etudes Spatiales (CNES), France
Copyright (c) 2012, CS Systemes d'Information, France

All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:
1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS \`AS IS'
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED.  IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE
LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.`,
  // The bundler drops these file headers; the package's own LICENSE does not carry them.
  'pdf-lib': `#### base64-arraybuffer (ported in pdf-lib/cjs/utils/base64.js)

Copyright (c) 2012 Niklas von Hertzen. Licensed under the MIT license:

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

#### pdf.js and XPDF stream decoders (ported in pdf-lib/cjs/core/streams)

Copyright 2012 Mozilla Foundation. Copyright 1996-2003 Glyph & Cog, LLC.

The Stream, DecodeStream, Ascii85Stream, AsciiHexStream, FlateStream, LZWStream and
RunLengthStream classes are TypeScript ports of Mozilla's pdf.js (the flate decoder in
turn of XPDF), made available under the Apache License 2.0, whose text appears under
pdfjs-dist below.

#### pdfkit (SVG path parser ported in pdf-lib/cjs/api/svgPath.js)

Copyright (c) 2014 Devon Govett. Licensed under the MIT license:

${mit}

pdf-lib's font embedders also credit https://github.com/foliojs/pdfkit for the approach
they follow.`,
  // The bundler drops the copyright header of index.js; the package's LICENSE is the unfilled Apache template.
  'diff-match-patch': `Copyright 2018 The diff-match-patch Authors. https://github.com/google/diff-match-patch`,
};
let notices = (await readFile('THIRD_PARTY_NOTICES.md', 'utf8')).split('## Bundled HTML parser')[0] + '## Bundled HTML parser and workflow dependencies\n\n';
for (const root of [...roots].sort()) {
  const pkg = JSON.parse(await readFile(`${root}/package.json`, 'utf8'));
  const license = (await readdir(root)).find(name => /^licen[sc]e(?:\.|$)/i.test(name));
  if (!license) throw new Error(`Missing license for bundled package ${pkg.name}`);
  notices += `### ${pkg.name} ${pkg.version}\n\n${await readFile(`${root}/${license}`, 'utf8')}\n\n`;
  if (embedded[pkg.name]) notices += `${embedded[pkg.name]}\n\n`;
}
await writeFile('THIRD_PARTY_NOTICES.md', notices.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trimEnd() + '\n');
console.log('Built extension and comment worker; no olcli configuration store in bundle.');
