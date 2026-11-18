import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDoc } from '../src/core/docState';
import type { Inspection } from '../src/core/models';
import { checkInspection, Expectations } from './ce/check';
import { DocPlan, planProject } from './ce/seed';
import { modernReply } from './fixtureServer';

const inspection = (): Inspection => ({
  projectId: 'p', projectName: 'CE', fetchedAt: '', missingFiles: [], unassignedThreadCount: 0,
  docs: [normalizeDoc('main.tex', 'modern', modernReply)],
  threads: Object.fromEntries(['c1', 'c2', 'c3', 'c4'].map(id => [id, { id, resolved: id === 'c2', messages: [] }])),
});
const expected = (): Expectations => ({ unassignedThreads: 0, docs: [{
  path: 'main.tex', text: 'Alpha βeta.\nSecond line.\n',
  anchors: [
    { label: 'open', threadId: 'c1', state: 'placed', ranges: [{ pos: 0, length: 5 }], rawRanges: [{ pos: 0, length: 5 }], resolved: false },
    { label: 'resolved', threadId: 'c2', state: 'placed', ranges: [{ pos: 6, length: 0 }, { pos: 6, length: 4 }], rawRanges: [{ pos: 6, length: 4 }, { pos: 10, length: 4 }], resolved: true },
    { label: 'removed', threadId: 'c3', state: 'anchor removed', ranges: [], rawRanges: [], resolved: false },
    { label: 'unknown', threadId: 'c4', state: 'position unknown', ranges: [], resolved: false },
  ],
  suggestions: [{ label: 'delete', kind: 'delete', pos: 6, text: 'old ' }, { label: 'insert', kind: 'insert', pos: 6, text: 'βeta' }],
}] });

test('CE expectation check accepts a matching inspection', () => {
  assert.deepEqual(checkInspection(inspection(), expected()), []);
});

test('CE expectation check reports shifted anchors, wrong states, missing suggestions and text drift', () => {
  const want = expected();
  want.docs[0].anchors[0].ranges[0].pos = 1;
  want.docs[0].anchors[1].resolved = false;
  want.docs[0].suggestions.pop();
  want.docs[0].text = 'Alpha beta.\nSecond line.\n';
  want.unassignedThreads = 1;
  const problems = checkInspection(inspection(), want).map(problem => `${problem.label}: ${problem.problem}`);
  assert.equal(problems.length, 5);
  assert.match(problems[0], /^text: accepted text differs from offset 6/);
  assert.equal(problems[1], 'open: ranges[0] at 0+5, expected 1+5');
  assert.equal(problems[2], 'resolved: thread resolved, expected open');
  assert.match(problems[3], /^unexpected suggestion: tracked insert/);
  assert.equal(problems[4], 'unassigned threads: 0, expected 1');
});

test('CE checker rejects missing, extra, reordered and shifted secondary ranges', () => {
  for (const [label, mutate] of Object.entries({
    missing: (ranges: { pos: number; length: number }[]) => ranges.pop(),
    extra: (ranges: { pos: number; length: number }[]) => ranges.push({ pos: 12, length: 1 }),
    reordered: (ranges: { pos: number; length: number }[]) => ranges.reverse(),
    shifted: (ranges: { pos: number; length: number }[]) => ranges[1].pos++,
    resized: (ranges: { pos: number; length: number }[]) => ranges[1].length--,
  })) {
    const got = inspection();
    mutate(got.docs[0].comments[1].ranges);
    assert.ok(checkInspection(got, expected()).some(p => p.label === 'resolved' && p.problem.startsWith('ranges')), label);
  }
  const got = inspection();
  got.docs[0].comments[0].ranges = [];
  assert.ok(checkInspection(got, expected()).some(p => p.label === 'open' && p.problem === 'ranges count 0, expected 1'));
});

test('CE checker rejects lost or changed raw ranges even when visible ranges match', () => {
  for (const mutation of ['missing', 'shifted', 'resized'] as const) {
    const got = inspection(), anchor = got.docs[0].comments[1];
    if (mutation === 'missing') delete anchor.rawRanges;
    else if (mutation === 'shifted') anchor.rawRanges![0].pos++;
    else anchor.rawRanges![0].length--;
    assert.ok(checkInspection(got, expected()).some(p => p.label === 'resolved' && p.problem.startsWith('rawRanges')), mutation);
  }
});

// Only a structural check for the two baseline files' disjoint edits. It does not
// model history-ot splits or merging. The edge cases are checked against real CE.
interface HistoryDoc { content: string; comments: { id: string; ranges: { pos: number; length: number }[] }[]; trackedChanges: { range: { pos: number; length: number }; tracking: object }[]; }
function applyHistoryOt(doc: HistoryDoc, op: any): void {
  if (op.commentId) { if (op.ranges) doc.comments.push({ id: op.commentId, ranges: op.ranges.map((r: object) => ({ ...r })) }); return; }
  const base = op.textOperation.reduce((n: number, part: any) => n + (typeof part === 'number' ? Math.abs(part) : typeof part === 'object' && 'r' in part ? part.r : 0), 0);
  assert.equal(base, doc.content.length, 'a text operation must span the whole content');
  const ranges = () => [...doc.comments.flatMap(comment => comment.ranges), ...doc.trackedChanges.map(change => change.range)];
  let cursor = 0;
  for (const part of op.textOperation) {
    if (typeof part === 'number' && part > 0) cursor += part;
    else if (typeof part === 'object' && 'r' in part) { doc.trackedChanges.push({ range: { pos: cursor, length: part.r }, tracking: part.tracking }); cursor += part.r; }
    else if (typeof part === 'string' || (typeof part === 'object' && 'i' in part)) {
      const text: string = typeof part === 'string' ? part : part.i;
      for (const range of ranges()) { if (range.pos >= cursor) range.pos += text.length; else if (range.pos + range.length > cursor) range.length += text.length; }
      doc.content = doc.content.slice(0, cursor) + text + doc.content.slice(cursor);
      if (typeof part === 'object') doc.trackedChanges.push({ range: { pos: cursor, length: text.length }, tracking: part.tracking });
      cursor += text.length;
    } else {
      const n = -part, end = cursor + n;
      for (const range of ranges()) {
        const rangeEnd = range.pos + range.length;
        if (range.pos >= end) range.pos -= n;
        else if (rangeEnd > cursor) { range.length = Math.max(0, cursor - range.pos) + Math.max(0, rangeEnd - end); range.pos = Math.min(range.pos, cursor); }
      }
      doc.content = doc.content.slice(0, cursor) + doc.content.slice(end);
      for (const comment of doc.comments) comment.ranges = comment.ranges.filter(range => range.length > 0);
    }
  }
}

test('baseline history-ot seeding operations produce the planned anchors and suggestions', () => {
  const plan = planProject();
  for (const doc of plan.docs) {
    if (!(doc instanceof DocPlan)) continue;
    const state: HistoryDoc = { content: doc.initialText, comments: [], trackedChanges: [] };
    for (const op of doc.historyOtOps('aaaaaaaaaaaaaaaaaaaaaaaa', '2026-10-21T00:00:00.000Z')) applyHistoryOt(state, op);
    state.trackedChanges.sort((a, b) => a.range.pos - b.range.pos);
    const inspection: Inspection = {
      projectId: 'p', projectName: 'CE', fetchedAt: '', missingFiles: [], unassignedThreadCount: 0,
      docs: [normalizeDoc(doc.path, 'd', [state, doc.edits.length, [], {}, 'history-ot'])],
      threads: Object.fromEntries(doc.threads.map(thread => [thread.threadId, { id: thread.threadId, resolved: thread.resolved, messages: [] }])),
    };
    const expected = doc.expected('history-ot');
    assert.deepEqual(checkInspection(inspection, { docs: [expected], unassignedThreads: 0 }), []);
    assert.ok(expected.suggestions.length && expected.anchors.length);
  }
});
