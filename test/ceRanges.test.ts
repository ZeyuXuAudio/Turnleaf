import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDoc } from '../src/core/docState';
import type { Inspection } from '../src/core/models';
import { checkInspection, type Expectations } from './ce/check';
import { RangeCasesPlan } from './ce/rangeCases';

test('history range projection keeps hidden middle ranges and document-boundary points', () => {
  // Independent raw reply with deletions at BOF, in the middle and at EOF.
  const doc = normalizeDoc('range-cases.tex', 'd', [{
    content: 'LEADleft NEWDROPEND rightTAIL',
    comments: [
      { id: 'split', ranges: [{ pos: 4, length: 5 }, { pos: 12, length: 4 }, { pos: 19, length: 6 }] },
      { id: 'hidden', ranges: [{ pos: 0, length: 4 }, { pos: 12, length: 4 }, { pos: 25, length: 4 }] },
      { id: 'ends-at-start', ranges: [{ pos: 4, length: 8 }] },
      { id: 'starts-at-end', ranges: [{ pos: 16, length: 9 }] },
      { id: 'multiple', ranges: [{ pos: 4, length: 2 }, { pos: 7, length: 2 }, { pos: 19, length: 6 }] },
    ],
    trackedChanges: [0, 12, 25].map(pos => ({ range: { pos, length: 4 }, tracking: { type: 'delete', userId: 'reviewer' } })),
  }, 1, [], {}, 'history-ot']);
  assert.equal(doc.text, 'left NEWEND right');
  assert.deepEqual(doc.comments.map(c => [c.state, c.ranges]), [
    ['placed', [{ pos: 0, length: 5 }, { pos: 8, length: 0 }, { pos: 11, length: 6 }]],
    ['hidden', [{ pos: 0, length: 0 }, { pos: 8, length: 0 }, { pos: 17, length: 0 }]],
    ['placed', [{ pos: 0, length: 8 }]],
    ['placed', [{ pos: 8, length: 9 }]],
    ['placed', [{ pos: 0, length: 2 }, { pos: 3, length: 2 }, { pos: 11, length: 6 }]],
  ]);
  assert.deepEqual(doc.comments[1].rawRanges, [{ pos: 0, length: 4 }, { pos: 12, length: 4 }, { pos: 25, length: 4 }]);
  assert.deepEqual(doc.changes.map(c => [c.pos, c.text]), [[0, 'LEAD'], [8, 'DROP'], [17, 'TAIL']]);
  assert.deepEqual(doc.diagnostics, []);
});

test('CE checker distinguishes hidden anchors from removed anchors and checks every hidden point', () => {
  const doc = normalizeDoc('hidden.tex', 'd', [{ content: 'OLD', comments: [{ id: 'h', ranges: [{ pos: 0, length: 1 }, { pos: 2, length: 1 }] }],
    trackedChanges: [{ range: { pos: 0, length: 3 }, tracking: { type: 'delete', userId: 'r' } }],
  }, 1, [], {}, 'history-ot']);
  const inspection: Inspection = { projectId: 'p', projectName: 'CE', fetchedAt: '', docs: [doc], missingFiles: [], unassignedThreadCount: 0,
    threads: { h: { id: 'h', resolved: false, messages: [] } } };
  const expected: Expectations = { unassignedThreads: 0, docs: [{ path: 'hidden.tex', text: '',
    anchors: [{ label: 'hidden', threadId: 'h', resolved: false, state: 'hidden',
      ranges: [{ pos: 0, length: 0 }, { pos: 0, length: 0 }], rawRanges: [{ pos: 0, length: 1 }, { pos: 2, length: 1 }] }],
    suggestions: [{ label: 'delete', kind: 'delete', pos: 0, text: 'OLD' }],
  }] };
  assert.deepEqual(checkInspection(inspection, expected), []);
  doc.comments[0].ranges.pop();
  assert.ok(checkInspection(inspection, expected).some(p => p.problem === 'ranges count 1, expected 2'));
  doc.comments[0].state = 'anchor removed';
  assert.ok(checkInspection(inspection, expected).some(p => p.problem === 'anchor state anchor removed, expected hidden'));
});

test('CE edge fixture operations span the document and produce the independently specified text', () => {
  const plan = new RangeCasesPlan();
  for (const type of ['history-ot', 'sharejs-text-ot'] as const) {
    let content = plan.initialText;
    const comments = new Set<string>();
    for (const { op: value, threadId } of plan.operations(type, 'aaaaaaaaaaaaaaaaaaaaaaaa', '2026-10-22T00:00:00Z')) {
      const op = value as any;
      if (threadId) { assert.ok(!comments.has(threadId)); comments.add(threadId); continue; }
      if (type === 'sharejs-text-ot') {
        if ('i' in op) content = content.slice(0, op.p) + op.i + content.slice(op.p);
        else {
          assert.equal(content.slice(op.p, op.p + op.d.length), op.d);
          content = content.slice(0, op.p) + content.slice(op.p + op.d.length);
        }
      } else {
        let consumed = 0, next = '';
        for (const part of op.textOperation) {
          if (typeof part === 'string') next += part;
          else {
            const n = typeof part === 'number' ? part : part.r;
            assert.ok(n > 0);
            next += content.slice(consumed, consumed + n);
            consumed += n;
          }
        }
        assert.equal(consumed, content.length, 'each text operation must consume the entire raw document');
        content = next;
      }
    }
    assert.equal(comments.size, plan.threads.length);
    assert.equal(content, type === 'history-ot'
      ? '^LEAD body\nPréface β\nleft NEWDROPEND right\nABxCDyEF\nred gap blue gone gold\ntail !END'
      : '^ body\nPréface β\nleft NEWEND right\nABxCDyEF\nred gap blue  gold\ntail !');
    assert.equal(plan.expected(type).text, '^ body\nPréface β\nleft NEWEND right\nABxCDyEF\nred gap blue  gold\ntail !');
  }
});
