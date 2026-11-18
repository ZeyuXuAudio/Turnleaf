import { randomBytes } from 'node:crypto';
import type { Anchor, Range } from '../../src/core/models';
import type { ExpectedDoc } from './check';
import type { OtType, SeedDoc, SeedOperation } from './seed';

type Pair = [number, number];
type TextEdit = { pos: number; insert: string } | { pos: number; delete: string };
interface CaseAnchor {
  label: string;
  before: Pair[];
  raw: Pair[];
  visible: Pair[];
  legacy: Pair;
  hidden?: boolean;
}
interface RangeCase {
  before: string;
  raw: string;
  accepted: string;
  anchors: CaseAnchor[];
  history: TextEdit[];
  legacy: TextEdit[];
  deletion?: { text: string; historyPos: number; legacyPos: number };
}

// Hand-written states in local UTF-16 coordinates, independent of the normalizer
// and of DocPlan's simple shift model. Deletes are tracked; inserts are untracked.
// Each history insert deliberately names its RAW side of the deletion. This seeds
// editor operations, not uploads or a general filtered-to-raw diff algorithm.
const cases: RangeCase[] = [
  {
    before: 'LEAD body\n', raw: '^LEAD body\n', accepted: '^ body\n',
    anchors: [
      { label: 'hidden at BOF', before: [[0, 4]], raw: [[1, 4]], visible: [[1, 0]], legacy: [1, 0], hidden: true },
      { label: 'after BOF deletion', before: [[4, 5]], raw: [[5, 5]], visible: [[1, 5]], legacy: [1, 5] },
    ],
    history: [{ pos: 0, delete: 'LEAD' }, { pos: 0, insert: '^' }],
    legacy: [{ pos: 0, delete: 'LEAD' }, { pos: 0, insert: '^' }],
    deletion: { text: 'LEAD', historyPos: 1, legacyPos: 1 },
  },
  // Non-ASCII BMP text precedes the remaining cases: offsets are not UTF-8 bytes.
  // Overleaf imports text containing surrogate pairs as a binary file.
  { before: 'Préface β\n', raw: 'Préface β\n', accepted: 'Préface β\n', anchors: [], history: [], legacy: [] },
  {
    before: 'left DROP right\n', raw: 'left NEWDROPEND right\n', accepted: 'left NEWEND right\n',
    anchors: [
      { label: 'hidden between boundary inserts', before: [[5, 4]], raw: [[8, 4]], visible: [[8, 0]], legacy: [11, 0], hidden: true },
      { label: 'spans both deletion boundaries', before: [[0, 15]], raw: [[0, 5], [8, 4], [15, 6]], visible: [[0, 5], [8, 0], [11, 6]], legacy: [0, 17] },
      { label: 'ends at deletion start', before: [[0, 5]], raw: [[0, 5]], visible: [[0, 5]], legacy: [0, 5] },
      { label: 'starts at deletion end', before: [[9, 6]], raw: [[15, 6]], visible: [[11, 6]], legacy: [11, 6] },
      { label: 'ends inside deletion', before: [[0, 7]], raw: [[0, 5], [8, 2]], visible: [[0, 5], [8, 0]], legacy: [0, 5] },
      { label: 'starts inside deletion', before: [[7, 8]], raw: [[10, 2], [15, 6]], visible: [[8, 0], [11, 6]], legacy: [11, 6] },
    ],
    history: [{ pos: 5, delete: 'DROP' }, { pos: 5, insert: 'NEW' }, { pos: 12, insert: 'END' }],
    legacy: [{ pos: 5, delete: 'DROP' }, { pos: 5, insert: 'NEW' }, { pos: 8, insert: 'END' }],
    // In history-ot END follows the retained deletion; in sharejs both inserts move its point right.
    deletion: { text: 'DROP', historyPos: 8, legacyPos: 11 },
  },
  {
    before: 'ABCDEF\n', raw: 'ABxCDyEF\n', accepted: 'ABxCDyEF\n',
    anchors: [
      { label: 'split twice by insertions', before: [[0, 6]], raw: [[0, 2], [3, 2], [6, 2]], visible: [[0, 2], [3, 2], [6, 2]], legacy: [0, 8] },
      { label: 'insertion at range end', before: [[0, 2]], raw: [[0, 2]], visible: [[0, 2]], legacy: [0, 2] },
      { label: 'insertion at range start', before: [[4, 2]], raw: [[6, 2]], visible: [[6, 2]], legacy: [6, 2] },
    ],
    history: [{ pos: 2, insert: 'x' }, { pos: 5, insert: 'y' }],
    legacy: [{ pos: 2, insert: 'x' }, { pos: 5, insert: 'y' }],
  },
  {
    before: 'red gap blue gone gold\n', raw: 'red gap blue gone gold\n', accepted: 'red gap blue  gold\n',
    anchors: [
      { label: 'multiple ranges with hidden middle', before: [[0, 3], [8, 4], [13, 4], [18, 4]], raw: [[0, 3], [8, 4], [13, 4], [18, 4]], visible: [[0, 3], [8, 4], [13, 0], [14, 4]], legacy: [0, 18] },
      { label: 'multiple wholly hidden ranges', before: [[13, 1], [15, 2]], raw: [[13, 1], [15, 2]], visible: [[13, 0], [13, 0]], legacy: [13, 0], hidden: true },
    ],
    history: [{ pos: 13, delete: 'gone' }], legacy: [{ pos: 13, delete: 'gone' }],
    deletion: { text: 'gone', historyPos: 13, legacyPos: 13 },
  },
  {
    // No final newline: this is the actual end of the document.
    before: 'tail END', raw: 'tail !END', accepted: 'tail !',
    anchors: [
      { label: 'hidden at EOF', before: [[5, 3]], raw: [[6, 3]], visible: [[6, 0]], legacy: [6, 0], hidden: true },
      { label: 'ends before EOF deletion', before: [[0, 5]], raw: [[0, 5]], visible: [[0, 5]], legacy: [0, 5] },
      { label: 'spans EOF deletion', before: [[0, 8]], raw: [[0, 5], [6, 3]], visible: [[0, 5], [6, 0]], legacy: [0, 5] },
    ],
    history: [{ pos: 5, delete: 'END' }, { pos: 5, insert: '!' }],
    legacy: [{ pos: 5, delete: 'END' }, { pos: 5, insert: '!' }],
    deletion: { text: 'END', historyPos: 6, legacyPos: 6 },
  },
];

const ranges = (pairs: Pair[], offset: number): Range[] => pairs.map(([pos, length]) => ({ pos: offset + pos, length }));

export class RangeCasesPlan implements SeedDoc {
  readonly path = 'range-cases.tex';
  readonly initialText = cases.map(c => c.before).join('');
  readonly threads = cases.flatMap(c => c.anchors.map(anchor => ({
    label: anchor.label, threadId: randomBytes(12).toString('hex'), message: `Harness thread: ${anchor.label}.`, resolved: false,
  })));

  operations(otType: OtType, userId: string, ts: string): SeedOperation[] {
    const result: SeedOperation[] = [];
    const modern = otType === 'history-ot';
    let length = this.initialText.length, offset = length;
    // Seed from the end, so each case's operations use unchanged initial offsets.
    // Only the total suffix retain changes; no comment/range transform is modeled here.
    for (const c of [...cases].reverse()) {
      offset -= c.before.length;
      for (const anchor of c.anchors) {
        const threadId = this.threads.find(thread => thread.label === anchor.label)!.threadId;
        const start = anchor.before[0][0], end = anchor.before.at(-1)![0] + anchor.before.at(-1)![1];
        result.push({ tracked: false, threadId, op: modern
          ? { commentId: threadId, ranges: ranges(anchor.before, offset) }
          // sharejs cannot represent multiple ranges; seed their covering range explicitly.
          : { p: offset + start, c: c.before.slice(start, end), t: threadId } });
      }
      for (const edit of modern ? c.history : c.legacy) {
        const p = offset + edit.pos;
        if ('insert' in edit) {
          result.push({ tracked: false, op: modern
            ? { textOperation: [p, edit.insert, length - p].filter(part => part !== 0) }
            : { p, i: edit.insert } });
          length += edit.insert.length;
        } else {
          const n = edit.delete.length;
          result.push({ tracked: true, op: modern
            ? { textOperation: [p, { r: n, tracking: { type: 'delete', userId, ts } }, length - p - n].filter(part => part !== 0) }
            : { p, d: edit.delete } });
          if (!modern) length -= n;
        }
      }
    }
    return result;
  }

  expected(otType: OtType): ExpectedDoc {
    const modern = otType === 'history-ot';
    const result: ExpectedDoc = { path: this.path, text: cases.map(c => c.accepted).join(''), anchors: [], suggestions: [] };
    let visibleOffset = 0, rawOffset = 0;
    for (const c of cases) {
      for (const anchor of c.anchors) {
        const threadId = this.threads.find(thread => thread.label === anchor.label)!.threadId;
        const state: Anchor['state'] = anchor.hidden ? modern ? 'hidden' : 'anchor removed' : 'placed';
        result.anchors.push({ label: anchor.label, threadId, resolved: false, state,
          ranges: ranges(modern ? anchor.visible : [anchor.legacy], visibleOffset),
          ...modern && { rawRanges: ranges(anchor.raw, rawOffset) } });
      }
      if (c.deletion) result.suggestions.push({ label: `delete ${c.deletion.text}`, kind: 'delete', text: c.deletion.text,
        pos: visibleOffset + (modern ? c.deletion.historyPos : c.deletion.legacyPos) });
      visibleOffset += c.accepted.length;
      rawOffset += c.raw.length;
    }
    return result;
  }
}
