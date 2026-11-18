import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { normalizeDoc } from '../src/core/docState';
import { diffText } from '../src/core/diff';
import { historyTextOp, shareJsOp, trackedChangeSeed } from '../src/core/textOps';
import { mapDocument } from '../src/core/ranges';
const File = require(resolve('test/reference/editor-core/lib/file_data/string_file_data.js'));
const TextOperation = require(resolve('test/reference/editor-core/lib/operation/text_operation.js'));
const { diffsToTextOperation } = require(resolve('test/reference/editor-core/lib/diff_as_text_operation.js'));
const Tracker = require(resolve('test/reference/ranges-tracker.cjs'));
const escape = (s: string) => Buffer.from(s).toString('latin1');

test('history-ot edits match the pinned Overleaf diff-to-operation result on 2,000 randomized documents', () => {
  let seed = 7121; const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const ts = '2026-10-29T12:00:00.000Z';
  for (let attempt = 0; attempt < 2000; attempt++) {
    const content = Array.from({ length: 1 + random(40) }, () => 'ab β\n'[random(5)]).join('');
    const changes = []; let p = 0;
    while (p < content.length) {
      if (random(4) === 0) { const length = Math.min(1 + random(4), content.length - p); changes.push({ range: { pos: p, length }, tracking: { type: random(2) ? 'insert' : 'delete', userId: 'reviewer', ts: '2026-10-27T12:00:00.000Z' } }); p += length; } else p++;
    }
    const comments = Array.from({ length: 2 }, (_, n) => { const pos = random(content.length), length = 1 + random(content.length - pos); return { id: `c${n}`, ranges: [{ pos, length }] }; });
    const raw = { content, comments, trackedChanges: changes };
    const doc = normalizeDoc('main.tex', 'd', [raw, 1, [], {}, 'history-ot']);
    let local = doc.text;
    for (let n = 0; n < 3; n++) { const at = random(local.length + 1); if (random(2)) local = local.slice(0, at) + 'XY\n'[random(3)] + local.slice(at); else local = local.slice(0, at) + local.slice(at + 1 + random(3)); }
    const diffs = diffText(doc.text, local, 0).diffs, tracking = random(2) ? { userId: 'author', ts } : undefined;
    const expected = File.fromRaw(structuredClone(raw)); expected.edit(diffsToTextOperation(expected, diffs, tracking ? { tracking: { userId: 'author', ts: new Date(ts) } } : {}));
    const actual = File.fromRaw(structuredClone(raw)); actual.edit(TextOperation.fromJSON({ textOperation: historyTextOp(doc, diffs, tracking) }));
    assert.deepEqual(actual.toRaw(), expected.toRaw(), `attempt ${attempt}`);
    assert.equal(normalizeDoc('main.tex', 'd', [actual.toRaw(), 2, [], {}, 'history-ot']).text, local);
  }
});

test('sharejs edits reproduce the reviewed text and the predicted anchors in the pinned range tracker', () => {
  const before = 'one two three four';
  for (const after of ['one Xtwo three four', 'one tXwo three four', 'one twoX three four', 'one three four', 'four', '', 'X' + before, before + 'X', 'one TWO three five']) {
    for (const track of [false, true]) {
      const comments = [{ op: { p: 4, c: 'two', t: 'c' } }], tracker = new Tracker([], structuredClone(comments));
      tracker.track_changes = track; tracker.setIdSeed(trackedChangeSeed());
      const diffs = diffText(before, after, 0).diffs, op = shareJsOp(diffs);
      let text = before;
      for (const component of op) text = 'i' in component ? text.slice(0, component.p) + component.i + text.slice(component.p) : text.slice(0, component.p) + text.slice(component.p + component.d.length);
      assert.equal(text, after);
      tracker.applyOps(op, { user_id: 'author', ts: new Date() });
      if (track) assert.equal(tracker.changes.filter((c: any) => c.op.i).map((c: any) => c.op.i).join(''), diffs.filter(([k]) => k === 1).map(([, t]) => t).join(''), 'Every insertion is a suggestion');
      if (!track) {
        const doc = normalizeDoc('main.tex', 'd', [[escape(before)], 1, [], { comments }, 'sharejs-text-ot']);
        const mapped = mapDocument(doc, after, false, diffs).comments[0];
        assert.deepEqual(mapped.ranges, [{ pos: tracker.comments[0].op.p, length: tracker.comments[0].op.c.length }], after);
      }
    }
  }
  assert.match(trackedChangeSeed(), /^[0-9a-f]{18}$/);
});
