import { Anchor, DocState, Range, Suggestion } from './models';
import { Diff, diffText } from './diff';

export interface MappedAnchor extends Anchor { label: string; }
export interface Mapping { comments: MappedAnchor[]; changes: Suggestion[]; affectedSuggestions: { suggestion: Suggestion; effect: string }[]; slow: boolean; trackedEdits: number; }
const end = (r: Range) => r.pos + r.length;
function merge(ranges: Range[]): Range[] {
  const out: Range[] = [];
  for (const r of ranges.filter(r => r.length > 0).sort((a, b) => a.pos - b.pos)) {
    const last = out.at(-1);
    if (last && end(last) >= r.pos) last.length = Math.max(end(last), end(r)) - last.pos;
    else out.push({ ...r });
  }
  return out;
}
export function insertRanges(ranges: Range[], pos: number, length: number, split: boolean): Range[] {
  return ranges.flatMap(r => {
    if (pos <= r.pos) return [{ pos: r.pos + length, length: r.length }];
    if (pos >= end(r)) return [{ ...r }];
    return split ? [{ pos: r.pos, length: pos - r.pos }, { pos: pos + length, length: end(r) - pos }] : [{ pos: r.pos, length: r.length + length }];
  });
}
export function deleteRanges(ranges: Range[], pos: number, length: number, keepPoint: boolean): Range[] {
  const move = (p: number) => p - Math.max(0, Math.min(length, p - pos));
  const result = ranges.map(r => ({ pos: move(r.pos), length: move(end(r)) - move(r.pos) }));
  return keepPoint ? result : merge(result);
}
export function mapPoint(point: number, diffs: Diff[]): number {
  let old = 0, mapped = point;
  for (const [kind, text] of diffs) {
    if (kind === 1) { if (old <= point) mapped += text.length; }
    else { if (kind === -1) mapped -= Math.max(0, Math.min(text.length, point - old)); old += text.length; }
  }
  return mapped;
}

// Original interval implementation of the documented behavior. Reference libraries are test-only.
export function mapDocument(doc: DocState, local: string, trackChanges = false, suppliedDiffs?: Diff[]): Mapping {
  const { diffs, slow } = suppliedDiffs ? { diffs: suppliedDiffs, slow: false } : diffText(doc.text, local);
  const modern = doc.otType === 'history-ot';
  const raw = doc.rawContent ?? doc.text;
  const changes = doc.rawChanges ?? [];
  const rawComments = doc.comments.map(c => ({ ...c, ranges: (modern ? c.rawRanges ?? [] : c.ranges).map(r => ({ ...r })) }));
  let rawDeletes = changes.filter(c => c.tracking.type === 'delete').map(c => ({ ...c.range }));
  let input = 0, output = 0;
  const touched = new Set<string>();
  const effects = new Map<string, string>();
  const mappedChanges: Suggestion[] = [];
  const edit = (kind: number, n: number, hidden = false) => {
    if (kind === 0) { input += n; output += n; return; }
    for (const c of rawComments) {
      const hit = c.ranges.some(r => kind === 1 ? output > r.pos && output < end(r) : output < end(r) && output + n > r.pos);
      if (hit) touched.add(c.threadId);
      c.ranges = kind === 1 ? insertRanges(c.ranges, output, n, modern) : hidden ? c.ranges : deleteRanges(c.ranges, output, n, !modern);
    }
    if (kind === 1) { rawDeletes = insertRanges(rawDeletes, output, n, true); output += n; }
    else { if (hidden) { rawDeletes = merge([...rawDeletes, { pos: output, length: n }]); output += n; } else rawDeletes = deleteRanges(rawDeletes, output, n, false); input += n; }
  };
  if (modern) {
    // Walk original raw boundaries; inserted/deleted output never changes the input cursor.
    for (const [kind, text] of diffs) {
      if (kind === 1) { edit(kind, text.length); continue; }
      let remaining = text.length;
      while (remaining) {
        const change = changes.find(c => input >= c.range.pos && input < end(c.range));
        if (change?.tracking.type === 'delete') { edit(0, end(change.range) - input); continue; }
        const next = changes.find(c => c.range.pos > input)?.range.pos ?? raw.length;
        const n = Math.min(remaining, change ? end(change.range) - input : next - input);
        if (n <= 0) throw new Error('Invalid raw document mapping. Refresh comments.');
        edit(kind, n, kind === -1 && trackChanges && change?.tracking.type !== 'insert');
        remaining -= n;
      }
    }
  } else {
    for (const [kind, text] of diffs) edit(kind, text.length);
  }
  // Suggestion impact is measured in the original accepted-text coordinates.
  let cursor = 0;
  for (const [kind, text] of diffs) {
    for (const change of doc.changes) {
      const hit = change.kind === 'delete'
        ? kind === 1 ? cursor === change.pos : kind === -1 && cursor <= change.pos && cursor + text.length >= change.pos
        : kind === 1 ? cursor > change.pos && cursor < change.pos + change.text.length : kind === -1 && cursor < change.pos + change.text.length && cursor + text.length > change.pos;
      if (hit) effects.set(change.id, !modern && trackChanges && kind === -1 && change.kind === 'delete' ? 'merged into your deletion; reviewer attribution lost' : change.kind === 'delete' ? 'edit at suggested deletion' : 'suggested insertion edited');
    }
    if (kind !== 1) cursor += text.length;
  }
  for (const c of doc.changes) {
    if (c.kind === 'delete') { mappedChanges.push({ ...c, pos: mapPoint(c.pos, diffs) }); continue; }
    let ranges = [{ pos: c.pos, length: c.text.length }], pos = 0;
    for (const [kind, text] of diffs) {
      if (kind === 1) { ranges = insertRanges(ranges, pos, text.length, true); pos += text.length; }
      else if (kind === -1) ranges = deleteRanges(ranges, pos, text.length, false);
      else pos += text.length;
    }
    for (const r of ranges) mappedChanges.push({ ...c, pos: r.pos, text: local.slice(r.pos, r.pos + r.length) });
  }
  const project = (p: number) => p - rawDeletes.reduce((sum, r) => sum + Math.max(0, Math.min(r.length, p - r.pos)), 0);
  const comments = rawComments.map((c, i): MappedAnchor => {
    const before = doc.comments[i];
    const ranges = modern ? c.ranges.map(r => ({ pos: project(r.pos), length: project(end(r)) - project(r.pos) })) : c.ranges;
    const hasVisible = ranges.some(r => r.length);
    let state: Anchor['state'] = before.state === 'position unknown' ? before.state : hasVisible ? 'placed' : modern && c.ranges.length ? 'hidden' : 'anchor removed';
    let label = before.state === 'position unknown' ? 'position unknown' : before.state === 'anchor removed' ? 'anchor removed' : before.state === 'hidden' ? 'anchor in a suggested deletion'
      : !hasVisible ? 'deleted locally' : touched.has(c.threadId) ? 'edited locally'
      : JSON.stringify(ranges) !== JSON.stringify(before.ranges) ? 'moved' : 'unchanged';
    if (!ranges.length) ranges.push({ pos: mapPoint(before.ranges[0]?.pos ?? 0, diffs), length: 0 });
    return { ...c, ranges, rawRanges: modern ? c.ranges : undefined, state, label };
  });
  return { comments, changes: mappedChanges, affectedSuggestions: doc.changes.filter(c => effects.has(c.id)).map(suggestion => ({ suggestion, effect: effects.get(suggestion.id)! })), slow, trackedEdits: trackChanges ? diffs.filter(d => d[0] !== 0).length : 0 };
}
