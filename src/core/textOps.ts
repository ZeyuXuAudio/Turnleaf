import { randomBytes } from 'node:crypto';
import type { Diff } from './diff';
import type { DocState } from './models';

// Reviewed diffs as realtime edit operations. The diffs compare the visible
// text (suggested deletions excluded) with the reviewed text, exactly as the
// preview does, so Overleaf receives the edits that were reviewed and nothing
// that only happens to differ elsewhere in the file.

// `u` marks an undo, which cancels a suggested deletion of the same text.
export type ShareJsComponent = { p: number; i: string; u?: boolean } | { p: number; d: string };
/** sharejs-text-ot: components apply in order, positions in the visible text. */
export function shareJsOp(diffs: Diff[]): ShareJsComponent[] {
  const op: ShareJsComponent[] = [];
  let position = 0;
  for (const [kind, text] of diffs) {
    if (!text) continue;
    if (kind === 0) position += text.length;
    else if (kind === 1) { op.push({ p: position, i: text }); position += text.length; }
    else op.push({ p: position, d: text });
  }
  return op;
}
/** The 18-hex-digit seed Overleaf derives tracked-change IDs from. */
export const trackedChangeSeed = () => randomBytes(9).toString('hex');

type Tracking = { type: 'insert' | 'delete'; userId: string; ts: string };
// A retain with tracking type 'none' clears a suggestion, keeping its text.
export type RawTextOp = number | string | { r: number; tracking: Tracking | { type: 'none' } } | { i: string; tracking: Tracking };
/**
 * history-ot: a text operation over the raw content, which still contains
 * suggested deletions. Those spans are stepped over with plain retains and
 * stay untouched. With `tracking`, insertions become suggested insertions and
 * removals suggested deletions, except inside existing suggested insertions,
 * which are removed outright, as when editing with Track Changes in Overleaf.
 */
export function historyTextOp(doc: DocState, diffs: Diff[], tracking?: { userId: string; ts: string }): RawTextOp[] {
  const raw = doc.rawContent ?? doc.text, changes = [...doc.rawChanges ?? []].sort((a, b) => a.range.pos - b.range.pos);
  const ops: RawTextOp[] = [];
  const push = (op: RawTextOp) => {
    const last = ops.at(-1);
    if (typeof op === 'number' && op > 0 && typeof last === 'number' && last > 0) ops[ops.length - 1] = last + op;
    else if (typeof op === 'number' && op < 0 && typeof last === 'number' && last < 0) ops[ops.length - 1] = last + op;
    else if (typeof op === 'string' && typeof last === 'string') ops[ops.length - 1] = last + op;
    else if (op !== 0 && op !== '') ops.push(op);
  };
  const retain = (length: number) => push(length);
  const remove = (length: number, insideInsert: boolean) => {
    if (!length) return;
    if (tracking && !insideInsert) {
      const last = ops.at(-1);
      if (last && typeof last === 'object' && 'r' in last) last.r += length; else ops.push({ r: length, tracking: { type: 'delete', ...tracking } });
    } else push(-length);
  };
  let cursor = 0; // position in the raw content
  // Advance over `length` visible characters, keeping or removing them.
  const visible = (length: number, keep: boolean) => {
    while (length > 0) {
      const deletion = changes.find(change => change.tracking.type === 'delete' && change.range.pos >= cursor && change.range.pos <= cursor);
      if (deletion) { retain(deletion.range.length); cursor += deletion.range.length; continue; }
      const nextDeletion = changes.find(change => change.tracking.type === 'delete' && change.range.pos > cursor);
      const insert = !keep && tracking ? changes.find(change => change.tracking.type === 'insert' && change.range.pos <= cursor && cursor < change.range.pos + change.range.length) : undefined;
      const nextInsert = !keep && tracking ? changes.find(change => change.tracking.type === 'insert' && change.range.pos > cursor) : undefined;
      let step = Math.min(length, (nextDeletion?.range.pos ?? raw.length) - cursor);
      if (insert) step = Math.min(step, insert.range.pos + insert.range.length - cursor);
      else if (nextInsert) step = Math.min(step, nextInsert.range.pos - cursor);
      if (keep) retain(step); else remove(step, !!insert);
      cursor += step; length -= step;
    }
  };
  for (const [kind, text] of diffs) {
    if (!text) continue;
    if (kind === 1) {
      const last = ops.at(-1);
      if (tracking) { if (last && typeof last === 'object' && 'i' in last) last.i += text; else ops.push({ i: text, tracking: { type: 'insert', ...tracking } }); }
      else push(text);
    } else visible(text.length, kind === 0);
  }
  // Suggested deletions at the very end are retained as well.
  for (const change of changes) if (change.tracking.type === 'delete' && change.range.pos >= cursor) { retain(change.range.pos - cursor + change.range.length); cursor = change.range.pos + change.range.length; }
  if (cursor < raw.length) retain(raw.length - cursor);
  return ops;
}
