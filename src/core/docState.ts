import { Anchor, DocState, Range } from './models';
import { protocolError, SyncError } from './errors';

// Raw protocol data is checked here before becoming typed application state.
export function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) protocolError();
  return value as Record<string, any>;
}
export function array(value: unknown): any[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) protocolError();
  return value;
}
function validRange(range: Range, length: number): boolean {
  return Number.isSafeInteger(range.pos) && Number.isSafeInteger(range.length) && range.pos >= 0 && range.length >= 0 && range.pos + range.length <= length;
}
function decode(text: unknown): string {
  if (typeof text !== 'string' || [...text].some(c => c.charCodeAt(0) > 255)) protocolError();
  // Each protocol string is text, not a file: a leading U+FEFF is content.
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.from(text, 'latin1')); }
  catch { return protocolError(); }
}

export function normalizeDoc(path: string, docId: string, reply: unknown[]): DocState {
  const [content, version, , rangeData, type = 'sharejs-text-ot'] = reply;
  if (!Number.isSafeInteger(version) || Number(version) < 0 || !['history-ot', 'sharejs-text-ot'].includes(String(type))) protocolError();
  const result: DocState = { path, docId, version: Number(version), otType: type as DocState['otType'], text: '', comments: [], changes: [], diagnostics: [] };
  const addAnchor = (threadId: unknown, ranges: Range[], valid: boolean, rawRanges?: Range[]) => {
    if (typeof threadId !== 'string' || !threadId) protocolError();
    const state: Anchor['state'] = !valid ? 'position unknown' : ranges.some(r => r.length) ? 'placed'
      : rawRanges?.some(r => r.length) ? 'hidden' : 'anchor removed';
    result.comments.push({ threadId, ranges: valid ? ranges : [], state,
      ...valid && rawRanges !== undefined && { rawRanges: rawRanges.map(r => ({ pos: r.pos, length: r.length })) } });
    if (!valid) result.diagnostics.push(`Thread ${threadId}: inconsistent anchor; position unknown.`);
  };

  if (type === 'history-ot') {
    const raw = object(content);
    if (typeof raw.content !== 'string') protocolError();
    const text: string = raw.content;
    const changes = array(raw.trackedChanges).map((value, index) => {
      const item = object(value), range = object(item.range) as unknown as Range, tracking = object(item.tracking);
      if (!validRange(range, text.length) || !['insert', 'delete'].includes(tracking.type)) protocolError();
      return { range, tracking, index };
    }).sort((a, b) => a.range.pos - b.range.pos);
    for (let i = 1; i < changes.length; i++) {
      if (changes[i].range.pos < changes[i - 1].range.pos + changes[i - 1].range.length) protocolError();
    }
    const deletions = changes.filter(c => c.tracking.type === 'delete').map(c => c.range);
    result.rawContent = text;
    result.rawChanges = changes.map(c => ({ range: { pos: c.range.pos, length: c.range.length }, tracking: { type: c.tracking.type, userId: String(c.tracking.userId ?? 'Unknown author'), ts: c.tracking.ts } }));
    const mapPosition = (position: number) => position - deletions.reduce((removed, range) => removed + Math.max(0, Math.min(range.length, position - range.pos)), 0);
    let cursor = 0;
    for (const range of deletions) {
      result.text += text.slice(cursor, range.pos);
      cursor = range.pos + range.length;
    }
    result.text += text.slice(cursor);
    for (const value of array(raw.comments)) {
      const comment = object(value);
      const ranges = array(comment.ranges).map(r => object(r) as unknown as Range);
      const valid = ranges.every((r, i) => validRange(r, text.length) && (!i || r.pos >= ranges[i - 1].pos + ranges[i - 1].length));
      const mapped = valid ? ranges.map(r => ({ pos: mapPosition(r.pos), length: mapPosition(r.pos + r.length) - mapPosition(r.pos) })) : [];
      addAnchor(comment.id, mapped, valid, ranges);
    }
    for (const { range, tracking, index } of changes) {
      result.changes.push({ id: `${docId}:${version}:${index}`, kind: tracking.type, pos: mapPosition(range.pos), text: text.slice(range.pos, range.pos + range.length), author: String(tracking.userId ?? 'Unknown author'), ...typeof tracking.userId === 'string' && { authorId: tracking.userId }, timestamp: tracking.ts });
    }
  } else {
    if (!Array.isArray(content)) protocolError();
    result.text = content.map(decode).join('\n');
    const raw = rangeData == null ? {} : object(rangeData);
    for (const value of array(raw.comments)) {
      const comment = object(value), op = object(comment.op);
      const anchor = decode(op.c);
      const range = { pos: op.p, length: anchor.length };
      addAnchor(op.t ?? comment.id, [range], validRange(range, result.text.length) && result.text.slice(range.pos, range.pos + range.length) === anchor);
    }
    for (const [index, value] of array(raw.changes).entries()) {
      const change = object(value), op = object(change.op), metadata = object(change.metadata ?? {});
      const kind = typeof op.i === 'string' ? 'insert' : typeof op.d === 'string' ? 'delete' : protocolError();
      const text = decode(kind === 'insert' ? op.i : op.d);
      if (!validRange({ pos: op.p, length: kind === 'insert' ? text.length : 0 }, result.text.length)) protocolError();
      if (kind === 'insert' && result.text.slice(op.p, op.p + text.length) !== text) protocolError();
      result.changes.push({ id: String(change.id ?? `${docId}:${version}:${index}`), kind, pos: op.p, text, author: String(metadata.user_id ?? 'Unknown author'), ...typeof metadata.user_id === 'string' && { authorId: metadata.user_id }, timestamp: metadata.ts });
    }
  }
  // No position-changing normalization without remapping. Imported Overleaf
  // documents use LF; reject unexpected CR until that mapping is implemented.
  if (result.text.includes('\r')) throw new SyncError('Overleaf returned unexpected CR line endings; positions were not guessed.', 'protocol');
  return result;
}

// allowEmpty: no files chosen yet is a valid setting, but nothing can be read or synchronized with it.
export function validateTrackedFiles(paths: unknown, options: { allowEmpty?: boolean } = {}): string[] {
  if (Array.isArray(paths) && !paths.length) {
    if (options.allowEmpty) return [];
    throw new SyncError('Choose the source files to synchronize first.', 'configuration');
  }
  if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string' || /[\\\x00-\x1f]/.test(path) || path.split('/').some((part: string) => !part || part === '.' || part === '..') || !/\.(tex|bib|sty|cls)$/i.test(path))) {
    throw new SyncError('Tracked files must be relative .tex, .bib, .sty or .cls paths without parent traversal.', 'configuration');
  }
  return [...new Set(paths as string[])];
}
