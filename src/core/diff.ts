// Same pinned Apache-2.0 diff-match-patch fork and settings as Overleaf.
const Dmp = require('diff-match-patch') as new () => {
  Diff_Timeout: number;
  diff_main(a: string, b: string): Diff[];
  diff_cleanupSemantic(diff: Diff[]): void;
};
export type Diff = [number, string];
export function diffText(before: string, after: string, timeout = 0.1): { diffs: Diff[]; slow: boolean } {
  const dmp = new Dmp();
  dmp.Diff_Timeout = timeout;
  const start = performance.now(), diffs = dmp.diff_main(before, after);
  dmp.diff_cleanupSemantic(diffs);
  return { diffs, slow: performance.now() - start > 50 };
}
export function changedLines(diffs: Diff[]): { added: number; removed: number } {
  const count = (kind: number) => diffs.filter(d => d[0] === kind).reduce((n, [, s]) => n + (s.match(/\n/g)?.length ?? 0) + (s.endsWith('\n') ? 0 : 1), 0);
  return { added: count(1), removed: count(-1) };
}

// Compose editor offsets with the last full comparison, without running a text diff.
export function composeEdits(original: string, diffs: Diff[], edits: readonly { rangeOffset: number; rangeLength: number; text: string }[]): Diff[] {
  type Piece = { start?: number; text: string };
  let old = 0, pieces: Piece[] = [];
  for (const [kind, text] of diffs) { if (kind !== -1) pieces.push({ start: kind === 0 ? old : undefined, text }); if (kind !== 1) old += text.length; }
  const slice = (from: number, to: number) => {
    const out: Piece[] = []; let cursor = 0;
    for (const p of pieces) { const a = Math.max(from - cursor, 0), b = Math.min(to - cursor, p.text.length); if (b > a) out.push({ start: p.start === undefined ? undefined : p.start + a, text: p.text.slice(a, b) }); cursor += p.text.length; }
    return out;
  };
  for (const edit of [...edits].sort((a, b) => b.rangeOffset - a.rangeOffset)) pieces = [...slice(0, edit.rangeOffset), ...(edit.text ? [{ text: edit.text }] : []), ...slice(edit.rangeOffset + edit.rangeLength, Infinity)];
  const result: Diff[] = []; old = 0; let inserted = '';
  const add = (kind: number, text: string) => { if (!text) return; if (result.at(-1)?.[0] === kind) result[result.length - 1][1] += text; else result.push([kind, text]); };
  const replace = (removed: string, added: string) => {
    // A delete followed by undo/retyping is unchanged text, not a deleted anchor.
    let prefix = 0, suffix = 0;
    while (prefix < Math.min(removed.length, added.length) && removed[prefix] === added[prefix]) prefix++;
    while (suffix < Math.min(removed.length, added.length) - prefix && removed[removed.length - 1 - suffix] === added[added.length - 1 - suffix]) suffix++;
    add(0, removed.slice(0, prefix));
    add(-1, removed.slice(prefix, removed.length - suffix));
    add(1, added.slice(prefix, added.length - suffix));
    if (suffix) add(0, removed.slice(-suffix));
  };
  for (const p of pieces) {
    if (p.start === undefined) inserted += p.text;
    else { replace(original.slice(old, p.start), inserted); inserted = ''; add(0, p.text); old = p.start + p.text.length; }
  }
  replace(original.slice(old), inserted);
  return result;
}
