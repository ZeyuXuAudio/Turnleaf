import test from 'node:test';
import assert from 'node:assert/strict';
import { changedLines, diffText } from '../src/core/diff';

// The sidebar's "+added −removed" counts the lines VS Code's diff editor marks on each side.
const counts = (before: string, after: string) => changedLines(diffText(before, after).diffs);
const text = (...rows: string[]) => rows.join('\n') + '\n';

test('an insertion inside a line marks that line on both sides', () => {
  assert.deepEqual(counts(text('one', 'We model the array response', 'three'), text('one', 'We model the 48\\,kHz array response', 'three')), { added: 1, removed: 1 });
});

test('an inserted line counts as one added line, also when the inserted text starts with a line break', () => {
  assert.deepEqual(counts(text('one', 'two', 'three'), text('one', 'two', 'new line', 'three')), { added: 1, removed: 0 });
  // A line added after a last line without a line break is the piece "\nwith 50% overlap.", which the old count took as two lines.
  assert.deepEqual(diffText('one\ntwo', 'one\ntwo\nwith 50\\% overlap.').diffs.filter(d => d[0] === 1).map(d => d[1]), ['\nwith 50\\% overlap.']);
  assert.deepEqual(counts('one\ntwo', 'one\ntwo\nwith 50\\% overlap.'), { added: 1, removed: 0 });
});

test('a deleted line counts as one removed line', () => {
  assert.deepEqual(counts(text('one', 'two', 'three'), text('one', 'three')), { added: 0, removed: 1 });
});

test('a changed line counts once on each side', () => {
  assert.deepEqual(counts(text('one', 'Each frame uses a Hann window.', 'three'), text('one', 'Each frame uses a Kaiser window!', 'three')), { added: 1, removed: 1 });
});

test('two edits on one line count that line once on each side', () => {
  const before = text('one', 'The input signal is sampled at 44.1 kHz and filtered.', 'three');
  const after = text('one', 'The input signal $x(t)$ is sampled at 48 kHz and filtered.', 'three');
  assert.ok(diffText(before, after).diffs.filter(d => d[0] !== 0).length >= 2, 'The character diff has two separate edits');
  assert.deepEqual(counts(before, after), { added: 1, removed: 1 });
});

test('a changed line followed by a new line, as in the demo merge', () => {
  assert.deepEqual(counts(text('Each frame uses a 512-sample Hann window.', 'The steering vector'), text('Each frame uses a 512-sample Hann window', 'with 50\\% overlap between adjacent frames.', 'The steering vector')), { added: 2, removed: 1 });
});

test('new, deleted and unchanged files, line endings and a final line break', () => {
  assert.deepEqual(counts('', text('one', 'two')), { added: 2, removed: 0 });
  assert.deepEqual(counts('', 'one\ntwo'), { added: 2, removed: 0 });
  assert.deepEqual(counts(text('one', 'two'), ''), { added: 0, removed: 2 });
  assert.deepEqual(counts(text('one', 'two'), text('one', 'two')), { added: 0, removed: 0 });
  assert.deepEqual(counts('one\r\ntwo\r\n', 'one\r\ntwo\r\nthree\r\n'), { added: 1, removed: 0 });
  // Adding a final line break adds VS Code's empty last line.
  assert.deepEqual(counts('one\ntwo', 'one\ntwo\n'), { added: 1, removed: 0 });
  // Repeated lines: only the extra copy is marked.
  assert.deepEqual(counts(text('x', 'x', 'x'), text('x', 'x', 'x', 'x')), { added: 1, removed: 0 });
});
