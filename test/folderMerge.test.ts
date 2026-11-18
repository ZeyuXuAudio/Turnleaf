import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeSaved } from '../src/core/savedFiles';

test('folder merge combines disjoint replacements and preserves identical overlapping edits once', async () => {
  const base = 'Alpha measurements.\n\nMiddle section.\n\nOmega result.\n';
  const local = base.replace('Alpha', 'New alpha');
  const remote = base.replace('Omega', 'Revised omega');
  const merged = await mergeSaved(base, local, remote);
  assert.equal(merged.conflict, false);
  assert.equal(merged.text, base.replace('Alpha', 'New alpha').replace('Omega', 'Revised omega'));
  assert.deepEqual(await mergeSaved(base, remote, local), merged);
  assert.deepEqual(await mergeSaved(base, local, local), { text: local, conflict: false });
});

test('folder merge retains both complete versions for overlapping edits and competing insertions', async () => {
  for (const [base, local, remote] of [
    ['measurement 0.64', 'measurement 0.70', 'measurement 0.62'],
    ['alpha\nomega\n', 'alpha\nlocal\nomega\n', 'alpha\nremote\nomega\n'],
    ['abc', 'ac', 'abXc'],
  ]) {
    const result = await mergeSaved(base, local, remote);
    assert(result.conflict);
    assert(result.text.includes(`<<<<<<< Saved local\n${local}`));
    assert(result.text.includes(`=======\n${remote}`));
  }
});
