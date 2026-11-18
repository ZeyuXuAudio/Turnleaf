import { randomBytes } from 'node:crypto';
import type { ExpectedAnchor, ExpectedDoc, ExpectedSuggestion } from './check';
import { RangeCasesPlan } from './rangeCases';

export type OtType = 'sharejs-text-ot' | 'history-ot';
export interface SeedOperation { op: unknown; tracked: boolean; threadId?: string; }
export interface SeedDoc {
  path: string;
  initialText: string;
  threads: { label: string; threadId: string; message: string; resolved: boolean }[];
  operations(otType: OtType, userId: string, ts: string): SeedOperation[];
  expected(otType: OtType): ExpectedDoc;
}

// Plans the baseline files' disjoint edits and their positions in accepted text.
// The overlapping/range-splitting cases use independent explicit operations and
// expectations in rangeCases.ts. This is not a general OT reference model.
export type Op = { c: string; p: number; t: string } | { i: string; p: number } | { d: string; p: number };
export interface Edit { op: Op; tracked: boolean; }
interface Item { label: string; pos: number; length: number; }

export const objectId = () => randomBytes(12).toString('hex');

export class DocPlan implements SeedDoc {
  readonly edits: Edit[] = [];
  readonly threads: { label: string; threadId: string; message: string; resolved: boolean }[] = [];
  private readonly anchors: (Item & { threadId: string; resolved: boolean })[] = [];
  private readonly suggestions: (Item & { kind: 'insert' | 'delete'; text: string })[] = [];
  private text: string;
  constructor(readonly path: string, readonly initialText: string) { this.text = initialText; }

  private find(snippet: string): number {
    const pos = this.text.indexOf(snippet);
    if (pos < 0 || this.text.indexOf(snippet, pos + 1) >= 0) throw new Error(`Seed text ${JSON.stringify(snippet)} must occur exactly once in ${this.path}.`);
    return pos;
  }
  private shift(items: Item[], at: number, inserted: number, deleted: number): void {
    for (const item of items) {
      if (inserted) {
        if (at <= item.pos) item.pos += inserted;
        else if (at < item.pos + item.length) item.length += inserted;
      } else {
        const end = at + deleted, itemEnd = item.pos + item.length;
        if (end <= item.pos) item.pos -= deleted;
        else if (at < itemEnd) {
          // Overlap: keep the parts of the item before and after the deletion.
          item.length = Math.max(0, at - item.pos) + Math.max(0, itemEnd - end);
          item.pos = Math.min(item.pos, at);
        }
      }
    }
  }
  private apply(op: Op, tracked: boolean): void {
    this.edits.push({ op, tracked });
    if ('i' in op) {
      this.text = this.text.slice(0, op.p) + op.i + this.text.slice(op.p);
      this.shift([...this.anchors, ...this.suggestions], op.p, op.i.length, 0);
    } else if ('d' in op) {
      this.text = this.text.slice(0, op.p) + this.text.slice(op.p + op.d.length);
      this.shift([...this.anchors, ...this.suggestions], op.p, 0, op.d.length);
    }
  }

  comment(label: string, snippet: string, options: { resolved?: boolean } = {}): string {
    const threadId = objectId(), pos = this.find(snippet), resolved = Boolean(options.resolved);
    this.threads.push({ label, threadId, message: `Harness thread: ${label}.`, resolved });
    this.anchors.push({ label, threadId, resolved, pos, length: snippet.length });
    this.apply({ c: snippet, p: pos, t: threadId }, false);
    return threadId;
  }
  /** An untracked deletion of exactly the commented text leaves a zero-length anchor. */
  removeText(snippet: string): void { this.apply({ d: snippet, p: this.find(snippet) }, false); }
  trackedInsert(label: string, after: string, text: string): void {
    const p = this.find(after) + after.length;
    this.apply({ i: text, p }, true);
    this.suggestions.push({ label, kind: 'insert', text, pos: p, length: text.length });
  }
  trackedDelete(label: string, snippet: string): void {
    const p = this.find(snippet);
    this.apply({ d: snippet, p }, true);
    // A tracked deletion occupies no characters in the accepted text.
    this.suggestions.push({ label, kind: 'delete', text: snippet, pos: p, length: 0 });
  }

  /**
   * The baseline's disjoint edits as history-ot raw operations, one per update.
   * Positions move past earlier tracked deletions. Edits at or across a deletion
   * boundary require explicit raw operations instead (see rangeCases.ts).
   */
  historyOtOps(userId: string, ts: string): unknown[] {
    const deleted: { pos: number; length: number }[] = [];
    let length = this.initialText.length;
    const toContent = (p: number) => deleted.slice().sort((a, b) => a.pos - b.pos).reduce((cp, d) => d.pos <= cp ? cp + d.length : cp, p);
    const text = (parts: unknown[]) => ({ textOperation: parts.filter(part => part !== 0) });
    return this.edits.map(({ op, tracked }) => {
      if ('c' in op) return { commentId: op.t, ranges: [{ pos: toContent(op.p), length: op.c.length }] };
      const p = toContent(op.p);
      if ('i' in op) {
        const rest = length - p;
        for (const d of deleted) if (d.pos >= p) d.pos += op.i.length;
        length += op.i.length;
        return text([p, tracked ? { i: op.i, tracking: { type: 'insert', userId, ts } } : op.i, rest]);
      }
      const n = op.d.length, rest = length - p - n;
      if (tracked) {
        deleted.push({ pos: p, length: n });
        return text([p, { r: n, tracking: { type: 'delete', userId, ts } }, rest]);
      }
      for (const d of deleted) if (d.pos > p) d.pos -= n;
      length -= n;
      return text([p, -n, rest]);
    });
  }

  operations(otType: OtType, userId: string, ts: string): SeedOperation[] {
    const history = otType === 'history-ot' ? this.historyOtOps(userId, ts) : [];
    return this.edits.map(({ op, tracked }, index) => ({
      op: otType === 'history-ot' ? history[index] : op, tracked, ...'t' in op && { threadId: op.t },
    }));
  }

  expected(otType: OtType): ExpectedDoc {
    return {
      path: this.path, text: this.text,
      anchors: this.anchors.map(({ label, threadId, resolved, pos, length }): ExpectedAnchor => ({
        label, threadId, resolved, state: length ? 'placed' : 'anchor removed',
        ranges: !length && otType === 'history-ot' ? [] : [{ pos, length }],
      })),
      suggestions: this.suggestions.map(({ label, kind, text, pos }): ExpectedSuggestion => ({ label, kind, text, pos })),
    };
  }
}

/** Baseline files plus explicit edge cases; the baseline planner handles only disjoint edits. */
export function planProject(): { docs: SeedDoc[]; unassignedThreads: { label: string; threadId: string; message: string }[] } {
  const main = new DocPlan('main.tex', [
    '\\documentclass{article}',
    '\\title{Überprüfung: Turnleaf harness}',
    '\\begin{document}',
    '\\maketitle',
    'Résumé: the first claim needs a citation \\cite{knuth1984}.',
    'The second claim is already resolved by the reviewer.',
    'This sentence will lose its commented phrase entirely.',
    'An obsolete clause stays here for a tracked deletion.',
    'A tracked insertion follows this marker:',
    '\\bibliographystyle{plain}',
    '\\bibliography{references}',
    '\\end{document}',
    '',
  ].join('\n'));
  main.comment('open thread', 'the first claim');
  main.comment('resolved thread', 'second claim', { resolved: true });
  main.comment('removed anchor', 'commented phrase');
  main.removeText('commented phrase');
  main.trackedDelete('tracked deletion', 'obsolete ');
  main.trackedInsert('tracked insertion', 'follows this marker:', ' inserted words');

  const references = new DocPlan('references.bib', [
    '@book{knuth1984,',
    '  author = {Donald E. Knuth and Jörg Señor},',
    '  title = {The TeXbook},',
    '  year = {1984},',
    '}',
    '',
  ].join('\n'));
  references.comment('bib thread', 'The TeXbook');
  references.trackedInsert('bib insertion', '  year = {1984},', '\n  note = {Seeded},');
  return { docs: [main, references, new RangeCasesPlan()], unassignedThreads: [{ label: 'unanchored thread', threadId: objectId(), message: 'Harness thread without an anchor.' }] };
}
