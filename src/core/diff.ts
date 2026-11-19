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
// The "+3 −1" next to a file counts the lines VS Code's diff editor marks for that file:
// `removed` is the lines shaded on the before side, `added` the lines shaded on the after side.
// A changed line is marked on both sides, so it counts once in each, also when the change is
// a few characters inside the line or several edits on that one line; a new line counts only
// in `added` and a deleted line only in `removed`. Lines are the text split at each line break
// (CRLF the same as LF), so a final line break leaves an empty last line, as in VS Code; they
// are compared in full, as with `diffEditor.ignoreTrimWhitespace` off, so a whitespace-only
// edit still shows in the count. A new file counts only added lines and a deleted file only
// removed lines. The lines are matched with diff-match-patch's line-level diff (a
// shortest edit script over whole lines), which can differ from VS Code's own matching only
// where several equally short scripts exist.
export function changedLines(diffs: Diff[]): { added: number; removed: number } {
  let before = '', after = '';
  for (const [kind, text] of diffs) { if (kind !== 1) before += text; if (kind !== -1) after += text; }
  return lineChanges(before, after);
}

export function lineChanges(before: string, after: string): { added: number; removed: number } {
  if (before === after) return { added: 0, removed: 0 };
  const counts = lineDiff(before.split(/\r?\n/), after.split(/\r?\n/));
  // VS Code shows an empty text as one empty line; the diff editor marks nothing on that side.
  return { added: after === '' ? 0 : counts.added, removed: before === '' ? 0 : counts.removed };
}

function lineDiff(a: string[], b: string[]): { added: number; removed: number } {
  // Unchanged first and last lines are not marked; the line diff runs on the rest.
  let start = 0, endA = a.length, endB = b.length;
  while (start < endA && start < endB && a[start] === b[start]) start++;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const middleA = a.slice(start, endA), middleB = b.slice(start, endB);
  if (!middleA.length || !middleB.length) return { added: middleB.length, removed: middleA.length };
  // Each distinct line becomes one UTF-16 code unit, outside the surrogate range.
  const codes = new Map<string, number>(), limit = 0xffff - 0x800;
  const encode = (rows: string[]) => rows.map(row => {
    let code = codes.get(row);
    if (code === undefined) { code = codes.size + 1; codes.set(row, code); }
    return String.fromCharCode(code < 0xd800 ? code : code + 0x800);
  }).join('');
  const charsA = encode(middleA), charsB = encode(middleB);
  // More distinct lines than code units: count every line between the unchanged ends.
  if (codes.size > limit) return { added: middleB.length, removed: middleA.length };
  const dmp = new Dmp();
  dmp.Diff_Timeout = 1;
  let added = 0, removed = 0;
  for (const [kind, text] of dmp.diff_main(charsA, charsB)) { if (kind === 1) added += text.length; else if (kind === -1) removed += text.length; }
  return { added, removed };
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
