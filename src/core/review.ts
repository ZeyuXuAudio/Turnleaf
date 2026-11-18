import { Inspection, Thread } from './models';
import { Cache, Reviews } from './storage';
import { Mapping, MappedAnchor, mapDocument } from './ranges';

export interface ReviewRow { path: string; docId: string; anchor: MappedAnchor; thread: Thread; line: number; excerpt: string; }
export function trackedInspection(inspection: Inspection, cache: Cache): Inspection {
  // Only comments are extended. Keep large text/OT payloads immutable and shared.
  const result = { ...inspection, docs: inspection.docs.map(doc => ({ ...doc, comments: [...doc.comments] })) };
  const documents = new Map(result.docs.map(doc => [doc.path, doc]));
  const placed = new Set(result.docs.flatMap(d => d.comments.map(c => c.threadId)));
  for (const [id, known] of Object.entries(cache.anchors)) {
    if (placed.has(id) || !result.threads[id]) continue;
    const doc = documents.get(known.path);
    if (doc) { doc.comments.push({ threadId: id, ranges: [], state: 'anchor removed' }); placed.add(id); }
  }
  result.unassignedThreadCount = Object.keys(result.threads).filter(id => !placed.has(id)).length;
  return result;
}
export function reviewRows(inspection: Inspection, cache: Cache, texts: Record<string, string>, mappings?: Map<string, Mapping>): ReviewRow[] {
  const rows: ReviewRow[] = [];
  for (const doc of trackedInspection(inspection, cache).docs) {
    const text = texts[doc.path] ?? doc.text, mapping = mappings?.get(doc.path) ?? mapDocument(doc, text, inspection.trackChanges);
    const comments = new Map(doc.comments.map(comment => [comment.threadId, comment]));
    const starts = [0];
    for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) starts.push(index + 1);
    const lineAt = (position: number) => {
      let low = 0, high = starts.length;
      while (low < high) { const mid = (low + high) >>> 1; if (starts[mid] <= position) low = mid + 1; else high = mid; }
      return low;
    };
    for (const anchor of mapping.comments) {
      const known = cache.anchors[anchor.threadId], remote = comments.get(anchor.threadId)!;
      const unknown = anchor.state === 'position unknown';
      const noRange = remote.state === 'anchor removed' && !remote.ranges.length;
      const pos = Math.min(text.length, anchor.ranges[0]?.pos ?? 0);
      const line = noRange ? Math.max(1, Math.min(known?.line ?? 1, starts.length)) : lineAt(pos);
      const excerpt = anchor.ranges.filter(r => r.length).map(r => text.slice(r.pos, r.pos + r.length)).join(' … ').slice(0, 80) || known?.excerpt || '';
      const thread = inspection.threads[anchor.threadId];
      if (thread) rows.push({ path: doc.path, docId: doc.docId, anchor, thread, line: unknown ? 0 : line, excerpt });
    }
  }
  return rows.sort((a, b) => Number(!a.line) - Number(!b.line) || a.path.localeCompare(b.path) || a.line - b.line || a.thread.id.localeCompare(b.thread.id));
}
/** Wording shown to people; the stored state stays `anchor removed`. */
export const anchorLabel = (label: string) => label === 'anchor removed' ? 'Text deleted' : label;
/** The commented text no longer exists, so a thread's line is only where it used to be. */
export const textGone = (label: string) => label === 'anchor removed' || label === 'deleted locally';
/** Records each thread's current place and text. Returns whether anything changed, so unchanged checks write nothing. */
export function rememberAnchors(cache: Cache, rows: ReviewRow[]): boolean {
  let changed = false;
  for (const row of rows) if (row.line && !['anchor removed', 'position unknown'].includes(row.anchor.label)) {
    const known = Object.hasOwn(cache.anchors, row.thread.id) ? cache.anchors[row.thread.id] : undefined;
    if (known?.path === row.path && known.line === row.line && known.excerpt === row.excerpt) continue;
    Object.defineProperty(cache.anchors, row.thread.id, { value: { path: row.path, line: row.line, excerpt: row.excerpt }, enumerable: true, writable: true, configurable: true });
    changed = true;
  }
  return changed;
}
export function localStatus(id: string, reviews: Reviews): string {
  const review = Object.hasOwn(reviews, id) ? reviews[id] : undefined;
  return !review || review.status === 'open' ? 'open locally' : review.status === 'addressed' ? `addressed in ${review.sha?.slice(0, 8)}` : `declined: ${review.reason}`;
}
const plain = (s: string) => s.replace(/[\\`*_[\]<>#]/g, '\\$&');
export function renderReviewLog(inspection: Inspection, rows: ReviewRow[], reviews: Reviews, snapshot?: string): string {
  const open = rows.filter(r => !r.thread.resolved).length, suggestions = inspection.docs.reduce((n, d) => n + d.changes.length, 0);
  const lines = ['# Overleaf review log', '', `Project: ${plain(inspection.projectName)} (${inspection.projectId})`, `Exported: ${new Date().toISOString()}`, `Snapshot: ${snapshot ?? 'not yet pulled'}`, `${open} open threads · ${suggestions} suggestions`, '', 'Generated file. Manual edits are overwritten.', ''];
  let section = '';
  for (const r of rows) {
    const next = r.line ? r.path : 'Unknown positions';
    if (next !== section) { section = next; lines.push(`## ${plain(section)}`, ''); }
    lines.push(`- **${plain(r.thread.id.slice(0, 8))}** · ${r.thread.resolved ? 'resolved' : 'open'} · ${anchorLabel(r.anchor.label)} · ${plain(r.path)}:${r.line || '?'} · ${plain(localStatus(r.thread.id, reviews))}`);
    if (r.excerpt) lines.push(`  > ${plain(r.excerpt).replace(/\n/g, '\n  > ')}`);
    for (const m of r.thread.messages) lines.push(`  - ${plain(m.author)}${m.timestamp !== undefined ? `, ${plain(String(m.timestamp))}` : ''}: ${plain(m.text).replace(/\n/g, '\n    ')}`);
    lines.push('');
  }
  return lines.join('\n');
}
