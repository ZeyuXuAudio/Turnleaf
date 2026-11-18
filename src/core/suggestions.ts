import type { Diff } from './diff';
import { diffText } from './diff';
import type { DocState, Suggestion } from './models';
import type { RawTextOp, ShareJsComponent } from './textOps';
import { SyncError } from './errors';

// Accepting or rejecting a suggested change, as Overleaf's review panel does.
// Accepting keeps the visible text; rejecting removes a suggested insertion or
// restores a suggested deletion.

export type Decision = 'accept' | 'reject';
/** Enough of a suggestion to find it again: history-ot IDs change with every version. */
export interface SuggestionRef { id: string; kind: 'insert' | 'delete'; pos: number; text: string; author: string; authorId?: string; timestamp?: string | number; }
export const suggestionRef = (s: Suggestion): SuggestionRef => ({ id: s.id, kind: s.kind, pos: s.pos, text: s.text, author: s.author, ...s.authorId !== undefined && { authorId: s.authorId }, ...s.timestamp !== undefined && { timestamp: s.timestamp } });
// A resolved name can change after a comment refresh. Older saved decisions
// have only `author`, which may contain either the name or the raw user ID.
const sameAuthor = (a: SuggestionRef, b: SuggestionRef) => a.authorId && b.authorId ? a.authorId === b.authorId
  : a.author === b.author || a.authorId === b.author || b.authorId === a.author;
const same = (s: Suggestion | SuggestionRef, ref: SuggestionRef) => s.kind === ref.kind && s.text === ref.text && sameAuthor(s, ref) && String(s.timestamp) === String(ref.timestamp);
/** The same suggestion, possibly read at another version. */
export const sameSuggestion = (a: SuggestionRef, b: SuggestionRef) => same(a, b);

/** The suggestion's index in `doc.changes`, or -1. A sharejs ID is stable; otherwise the nearest identical suggestion. */
export function findSuggestion(doc: DocState, ref: SuggestionRef): number {
  const byId = doc.changes.findIndex(s => s.id === ref.id && same(s, ref));
  if (byId >= 0) return byId;
  let best = -1;
  doc.changes.forEach((s, i) => { if (same(s, ref) && (best < 0 || Math.abs(s.pos - ref.pos) < Math.abs(doc.changes[best].pos - ref.pos))) best = i; });
  return best;
}
export const countSuggestion = (doc: DocState, ref: SuggestionRef) => doc.changes.filter(s => same(s, ref)).length;

/** The visible text after one decision. */
export function visibleAfter(text: string, s: Suggestion, decision: Decision): string {
  if (decision === 'accept') return text;
  return s.kind === 'insert' ? text.slice(0, s.pos) + text.slice(s.pos + s.text.length) : text.slice(0, s.pos) + s.text + text.slice(s.pos);
}
/** history-ot: retain everything but the suggestion; clear its tracking to keep it, remove it otherwise. */
export function historyDecisionOp(doc: DocState, index: number, decision: Decision): RawTextOp[] {
  const raw = doc.rawContent ?? doc.text, change = doc.rawChanges?.[index];
  if (!change) throw new SyncError(`${doc.path}: this suggestion is no longer on Overleaf.`, 'stale');
  const { pos, length } = change.range, keep = (change.tracking.type === 'insert') === (decision === 'accept');
  return [pos, keep ? { r: length, tracking: { type: 'none' as const } } : -length, raw.length - pos - length].filter(op => op !== 0);
}
/**
 * sharejs: Overleaf rejects a suggested insertion by deleting it, and a
 * suggested deletion by reinserting its text marked as an undo (`u`), which
 * the range tracker cancels against the deletion. Accepting uses the HTTP route.
 */
export function shareJsRejectOp(s: Suggestion): ShareJsComponent[] {
  return [s.kind === 'insert' ? { p: s.pos, d: s.text } : { p: s.pos, i: s.text, u: true }];
}

/** Where a span of `diffs`' old text lies in the new text, if neither it nor its inside was edited. */
function mapUntouched(diffs: Diff[], from: number, to: number): number | undefined {
  let old = 0, next = 0;
  for (const [kind, text] of diffs) {
    if (kind === 0 && from >= old && to <= old + text.length) return next + from - old;
    // A point where a local edit begins: before that edit.
    if (kind !== 0 && from === to && from === old) return next;
    if (kind !== 1) old += text.length;
    if (kind !== -1) next += text.length;
    if (old > from) return;
  }
  return from === old && to === old ? next : undefined;
}
/**
 * The local file after the rejections it will receive from Overleaf: each
 * rejected insertion removed and each rejected deletion restored at the same
 * place, which must not have been edited locally.
 */
export function rejectLocally(path: string, remote: string, local: string, rejected: Suggestion[]): string {
  if (!rejected.length) return local;
  const diffs = remote === local ? [[0, remote] as Diff] : diffText(remote, local).diffs;
  const placed = rejected.map(s => {
    const at = mapUntouched(diffs, s.pos, s.kind === 'insert' ? s.pos + s.text.length : s.pos);
    if (at === undefined) throw new SyncError(`${path}: you edited the text of a suggestion you rejected (near line ${remote.slice(0, s.pos).split('\n').length}). Undo that edit or discard the decision, then review again.`, 'conflict');
    return { s, at };
  }).sort((a, b) => b.at - a.at || (a.s.kind === 'insert' ? -1 : 1));
  return placed.reduce((text, { s, at }) => s.kind === 'insert' ? text.slice(0, at) + text.slice(at + s.text.length) : text.slice(0, at) + s.text + text.slice(at), local);
}
