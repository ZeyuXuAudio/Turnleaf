import type { DocState, Range } from './models';
import { SyncError } from './errors';

/** Map visible selected text to stored history-OT ranges, excluding hidden deletions. */
export function commentAttachment(doc: DocState, threadId: string, from: number, to: number): unknown {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from || to > doc.text.length) throw new SyncError('Select a non-empty source range before creating a comment.', 'configuration');
  if (doc.otType === 'sharejs-text-ot') return { p: from, c: doc.text.slice(from, to), t: threadId };
  const ranges: Range[] = [];
  const deleted = (doc.rawChanges ?? []).filter(change => change.tracking.type === 'delete').map(change => change.range).sort((a, b) => a.pos - b.pos);
  let raw = 0, visible = 0;
  for (const deletion of [...deleted, { pos: (doc.rawContent ?? doc.text).length, length: 0 }]) {
    const end = visible + deletion.pos - raw;
    const start = Math.max(from, visible), finish = Math.min(to, end);
    if (finish > start) ranges.push({ pos: raw + start - visible, length: finish - start });
    visible = end; raw = deletion.pos + deletion.length;
  }
  if (ranges.reduce((total, range) => total + range.length, 0) !== to - from) throw new SyncError('The selected comment range cannot be mapped reliably. Refresh and select it again.', 'stale');
  return { commentId: threadId, ranges };
}
