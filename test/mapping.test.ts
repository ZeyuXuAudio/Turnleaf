import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { normalizeDoc } from '../src/core/docState';
import { mapDocument } from '../src/core/ranges';
import { diffText } from '../src/core/diff';
const File = require(resolve('test/reference/editor-core/lib/file_data/string_file_data.js'));
const { diffsToTextOperation } = require(resolve('test/reference/editor-core/lib/diff_as_text_operation.js'));
const Tracker = require(resolve('test/reference/ranges-tracker.cjs'));
const DiffCodec = require(resolve('test/reference/DiffCodec.cjs'));
const escape = (s: string) => Buffer.from(s).toString('latin1');

test('pinned history-ot upload reference matches raw, projected and hidden anchors on 2,000 randomized cases', () => {
  let seed = 3917; const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let attempt = 0; attempt < 2000; attempt++) {
    const content = Array.from({ length: 1 + random(40) }, () => 'ab β\n'[random(5)]).join('');
    const changes = []; let p = 0;
    while (p < content.length) {
      if (random(4) === 0) { const length = Math.min(1 + random(4), content.length - p); changes.push({ range: { pos: p, length }, tracking: { type: random(2) ? 'insert' : 'delete', userId: 'reviewer', ts: '2026-10-27T12:00:00.000Z' } }); p += length; } else p++;
    }
    const comments = Array.from({ length: 3 }, (_, n) => {
      const pos = random(content.length), length = 1 + random(content.length - pos);
      return { id: `c${n}`, ranges: [{ pos, length }] };
    });
    const raw = { content, comments, trackedChanges: changes };
    const doc = normalizeDoc('main.tex', 'd', [raw, 1, [], {}, 'history-ot']);
    let local = doc.text;
    for (let n = 0; n < 3; n++) { const at = random(local.length + 1); if (random(2)) local = local.slice(0, at) + 'XY'[random(2)] + local.slice(at); else local = local.slice(0, at) + local.slice(at + 1 + random(3)); }
    const diffs = diffText(doc.text, local, 0).diffs, tracking = !!random(2);
    const file = File.fromRaw(structuredClone(raw)); file.edit(diffsToTextOperation(file, diffs, tracking ? { tracking: { userId: 'author', ts: new Date('2026-10-27T12:01:00.000Z') } } : {}));
    const expected = normalizeDoc('main.tex', 'd', [file.toRaw(), 2, [], {}, 'history-ot']);
    const actual = mapDocument(doc, local, tracking, diffs);
    assert.equal(expected.text, local);
    for (const c of actual.comments) {
      const e = expected.comments.find(e => e.threadId === c.threadId)!;
      assert.equal(c.state, e.state, `state at ${attempt}`); assert.deepEqual(c.rawRanges, e.rawRanges, `raw at ${attempt}`);
      // Local placement keeps a fallback point when the server drops all ranges.
      assert.deepEqual(c.ranges.filter(r => r.length), e.ranges.filter(r => r.length), `projected at ${attempt}`);
    }
  }
});
test('pinned sharejs upload and range tracker match interior/boundary insertions and deletions', () => {
  const before = 'one two three four';
  for (const after of ['one Xtwo three four', 'one tXwo three four', 'one twoX three four', 'one three four', 'four', '', 'X' + before, before + 'X']) {
    const comments = [{ op: { p: 4, c: 'two', t: 'c' } }], tracker = new Tracker([], structuredClone(comments));
    const doc = normalizeDoc('main.tex', 'd', [[escape(before)], 1, [], { comments }, 'sharejs-text-ot']);
    tracker.applyOps(DiffCodec.diffAsShareJsOp([before], [after]), {});
    const mapped = mapDocument(doc, after, false, diffText(before, after, 0).diffs).comments[0];
    assert.deepEqual(mapped.ranges, [{ pos: tracker.comments[0].op.p, length: tracker.comments[0].op.c.length }], after);
  }
});
test('Q8 hidden anchors survive uploads, interior inserts split, tracked deletes preserve covered text', () => {
  const raw = { content: 'one two three four', comments: [{ id: 'A', ranges: [{ pos: 0, length: 13 }] }, { id: 'B', ranges: [{ pos: 4, length: 3 }] }, { id: 'C', ranges: [{ pos: 8, length: 5 }] }], trackedChanges: [{ range: { pos: 4, length: 4 }, tracking: { type: 'delete', userId: 'reviewer' } }] };
  const doc = normalizeDoc('main.tex', 'd', [raw, 1, [], {}, 'history-ot']);
  const inserted = mapDocument(doc, 'one 2 three four'); assert.equal(inserted.comments[0].rawRanges?.length, 2); assert.equal(inserted.comments[1].state, 'hidden');
  assert.equal(mapDocument(doc, 'one four', false).comments[2].state, 'anchor removed');
  assert.equal(mapDocument(doc, 'one four', true).comments[2].state, 'hidden');
});
