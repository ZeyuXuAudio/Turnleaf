import test from 'node:test';
import assert from 'node:assert/strict';
import { deletionDisplay, deletionPreview, drawnDeletionDisplay, struckThrough } from '../src/extension/deletionDisplay';

test('an unknown deletion display setting falls back to struck-through text', () => {
  assert.equal(deletionDisplay('marker'), 'marker');
  assert.equal(deletionDisplay('inlayHint'), 'inlayHint');
  assert.equal(deletionDisplay(undefined), 'inline');
  assert.equal(deletionDisplay('ghost'), 'inline');
});

test('inlay hints hidden by the editor setting show the marker instead', () => {
  assert.equal(drawnDeletionDisplay('inlayHint', 'on'), 'inlayHint');
  assert.equal(drawnDeletionDisplay('inlayHint', 'onUnlessPressed'), 'inlayHint');
  assert.equal(drawnDeletionDisplay('inlayHint', 'off'), 'marker');
  assert.equal(drawnDeletionDisplay('inlayHint', 'offUnlessPressed'), 'marker');
  assert.equal(drawnDeletionDisplay('inline', 'off'), 'inline');
});

test('deleted text is shortened to 80 characters, with line breaks shown', () => {
  assert.equal(deletionPreview('a\nb'), 'a ⏎ b');
  const long = deletionPreview('x'.repeat(100));
  assert.equal(long.length, 80); assert(long.endsWith('…'));
  assert.equal(struckThrough('ab'), 'a̶b̶');
});
