/**
 * How a suggested deletion is drawn in the editor (`turnleaf.deletionDisplay`).
 * - `inline`: the deleted text, struck through, as a decoration. Word wrap does not count
 *   decorations, so a wrapped row that carries one can run past the editor's edge.
 * - `marker`: no text is added; the character at the deletion point is marked.
 * - `inlayHint`: the deleted text as an inlay hint, which word wrap counts.
 */
export type DeletionDisplay = 'inline' | 'marker' | 'inlayHint';
export const deletionDisplays: readonly DeletionDisplay[] = ['inline', 'marker', 'inlayHint'];

export function deletionDisplay(value: unknown): DeletionDisplay {
  return deletionDisplays.includes(value as DeletionDisplay) ? value as DeletionDisplay : 'inline';
}

/**
 * The style actually drawn. Inlay hints hidden by `editor.inlayHints.enabled` would hide the
 * deletions with them, so those editors get the marker instead.
 */
export function drawnDeletionDisplay(setting: DeletionDisplay, inlayHintsEnabled: unknown): DeletionDisplay {
  return setting === 'inlayHint' && (inlayHintsEnabled === 'off' || inlayHintsEnabled === 'offUnlessPressed') ? 'marker' : setting;
}

/** The deleted text as shown in the line: at most 80 characters, line breaks as ⏎. */
export function deletionPreview(text: string): string {
  return (text.length > 80 ? text.slice(0, 79) + '…' : text).replace(/\n/g, ' ⏎ ');
}

/** Inlay hints cannot be styled, so the strike is a combining stroke after each character. */
export function struckThrough(text: string): string {
  return [...text].map(ch => ch + '̶').join('');
}
