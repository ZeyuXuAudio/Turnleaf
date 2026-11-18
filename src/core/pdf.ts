import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PDFDocument, PDFArray, PDFHexString, PDFName } from 'pdf-lib';
import { ReviewRow, localStatus } from './review';
import { Reviews, workspacePath } from './storage';
import { SyncError } from './errors';
import { currentOperation, progress, checkCancelled } from './operation';

export function parseSyncTex(output: string): { page: number; x: number; y: number } | undefined {
  const page = Number(/^Page:(\d+)$/m.exec(output)?.[1]), x = Number(/^x:([\d.+-]+)$/m.exec(output)?.[1]), y = Number(/^y:([\d.+-]+)$/m.exec(output)?.[1]);
  return page > 0 && Number.isFinite(x) && Number.isFinite(y) ? { page, x, y } : undefined;
}
async function locate(line: number, source: string, pdf: string): Promise<ReturnType<typeof parseSyncTex>> {
  return new Promise((resolve, reject) => execFile('synctex', ['view', '-i', `${line}:0:${source}`, '-o', pdf], { signal: currentOperation()?.signal, timeout: 15_000, maxBuffer: 1024 * 1024 }, (e: any, stdout) => {
    if (e?.name === 'AbortError') { reject(new SyncError('PDF export cancelled.', 'cancelled')); return; }
    if (e?.code === 'ENOENT') reject(new SyncError('Install SyncTeX (included with TeX Live/MacTeX), compile with -synctex=1, and try again.', 'pdf'));
    else resolve(parseSyncTex(stdout));
  }));
}
export async function annotatePdf(folder: { root: string }, input: string, rows: ReviewRow[], reviews: Reviews, parserPath: string): Promise<{ path: string; annotated: number; skipped: string[] }> {
  progress('Reading compiled PDF…');
  const bytes = await readFile(input), document = await PDFDocument.load(bytes);
  // PDF.js is shipped as ESM next to the extension and evaluates no PDF-provided code.
  const parser = await (new Function('url', 'return import(url)'))(pathToFileURL(parserPath).href);
  parser.GlobalWorkerOptions.workerSrc = pathToFileURL(join(dirname(parserPath), 'pdf.worker.mjs')).href;
  const parsed = await parser.getDocument({ data: Uint8Array.from(bytes), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
  const skipped: string[] = [], pageItems = new Map<number, any[]>(); let annotated = 0;
  const positions = new Map<string, Awaited<ReturnType<typeof locate>>>();
  try {
    for (const row of rows) {
      progress(`Mapping comments to PDF (${annotated + skipped.length + 1}/${rows.length})…`);
      const key = `${row.path}:${row.line}`;
      if (row.line && !positions.has(key)) positions.set(key, await locate(row.line, join(folder.root, row.path), input));
      const position = positions.get(key);
      if (!position || position.page > document.getPageCount()) { skipped.push(`${row.path}:${row.line} (${row.thread.id})`); continue; }
      const page = document.getPage(position.page - 1), width = page.getWidth(), height = page.getHeight();
      let x = position.x, y = height - position.y, w = Math.min(200, width - x), h = 12;
      if (!pageItems.has(position.page)) pageItems.set(position.page, (await (await parsed.getPage(position.page)).getTextContent()).items);
      const items = pageItems.get(position.page)!;
      // Prefer a nearby match in the text layer; TeX commands often require the SyncTeX fallback.
      const needle = row.excerpt.replace(/\s+/g, ' ').trim();
      const matches = items.filter(item => needle && item.str?.includes(needle)).sort((a, b) => Math.abs(a.transform[5] - y) - Math.abs(b.transform[5] - y));
      if (matches[0]) { const item = matches[0], index = item.str.indexOf(needle), scale = item.width / Math.max(1, item.str.length); x = item.transform[4] + index * scale; y = item.transform[5]; w = needle.length * scale; h = Math.abs(item.height) || 12; }
      x = Math.max(0, Math.min(width - 1, x)); y = Math.max(0, Math.min(height - 1, y)); w = Math.max(1, Math.min(width - x, w)); h = Math.max(1, Math.min(height - y, h));
      const content = `${row.thread.resolved ? 'Resolved' : 'Open'} · ${row.anchor.label} · ${localStatus(row.thread.id, reviews)}\n${row.path}:${row.line}\n\n${row.thread.messages.map(m => `${m.author} (${m.timestamp ?? ''}): ${m.text}`).join('\n\n')}`;
      let annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
      if (!annots) { annots = document.context.obj([]); page.node.set(PDFName.of('Annots'), annots); }
      const noteX = width - 36;
      const note = document.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [noteX, y, noteX + 16, Math.min(height, y + 16)], Contents: PDFHexString.fromText(content), T: PDFHexString.fromText(row.thread.messages[0]?.author ?? 'Overleaf review'), Name: 'Comment', C: [1, 0.85, 0.2], F: 4 });
      annots.push(document.context.register(note));
      if (!['anchor removed', 'position unknown'].includes(row.anchor.label)) {
        const mark = document.context.obj({ Type: 'Annot', Subtype: 'Highlight', Rect: [x, y, x + w, y + h], QuadPoints: [x, y + h, x + w, y + h, x, y, x + w, y], Contents: PDFHexString.fromText(content), C: [1, 0.85, 0.2], CA: 0.3, F: 4 });
        annots.push(document.context.register(mark));
      }
      annotated++;
    }
  } finally { await parsed.destroy(); }
  if (!annotated) throw new SyncError('No threads could be mapped. Recompile the current source with SyncTeX enabled and choose its PDF.', 'pdf');
  const name = basename(input, '.pdf'), path = await workspacePath(folder.root, `build/${name}-review.pdf`);
  if (path === input) throw new SyncError('Choose the original compiled PDF, not the review copy.', 'pdf');
  checkCancelled();
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, await document.save());
  return { path, annotated, skipped };
}
