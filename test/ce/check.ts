import type { Anchor, Inspection, Range } from '../../src/core/models';

// Expected state of the throwaway Community Edition project seeded by test/ce/harness.ts.
// Positions refer to the accepted text (tracked deletions removed), as in DocState.
// All text here is synthetic, so problems may quote it.
export interface ExpectedAnchor { label: string; threadId: string; state: Anchor['state']; ranges: Range[]; rawRanges?: Range[]; resolved: boolean; }
export interface ExpectedSuggestion { label: string; kind: 'insert' | 'delete'; pos: number; text: string; }
export interface ExpectedDoc { path: string; text: string; anchors: ExpectedAnchor[]; suggestions: ExpectedSuggestion[]; }
export interface Expectations { docs: ExpectedDoc[]; unassignedThreads: number; }
export interface PositionProblem { path: string; label: string; problem: string; }

const quote = (text: string) => JSON.stringify(text.length > 40 ? text.slice(0, 37) + '...' : text);

export function checkInspection(inspection: Inspection, expected: Expectations): PositionProblem[] {
  const problems: PositionProblem[] = [];
  const add = (path: string, label: string, problem: string) => problems.push({ path, label, problem });
  for (const want of expected.docs) {
    const doc = inspection.docs.find(doc => doc.path === want.path);
    if (!doc) { add(want.path, 'document', 'not fetched'); continue; }
    if (doc.text !== want.text) {
      let i = 0;
      while (i < doc.text.length && doc.text[i] === want.text[i]) i++;
      add(want.path, 'text', `accepted text differs from offset ${i}: expected ${quote(want.text.slice(i))}, got ${quote(doc.text.slice(i))}`);
    }
    for (const anchor of want.anchors) {
      const got = doc.comments.find(comment => comment.threadId === anchor.threadId);
      if (!got) { add(want.path, anchor.label, 'thread anchor missing'); continue; }
      if (got.state !== anchor.state) add(want.path, anchor.label, `anchor state ${got.state}, expected ${anchor.state}`);
      const compareRanges = (name: string, actual: Range[] | undefined, expected: Range[]) => {
        if (!actual) { add(want.path, anchor.label, `${name} missing`); return; }
        if (actual.length !== expected.length) add(want.path, anchor.label, `${name} count ${actual.length}, expected ${expected.length}`);
        expected.forEach((range, index) => {
          const found = actual[index];
          if (found && (found.pos !== range.pos || found.length !== range.length)) {
            add(want.path, anchor.label, `${name}[${index}] at ${found.pos}+${found.length}, expected ${range.pos}+${range.length}`);
          }
        });
      };
      compareRanges('ranges', got.ranges, anchor.ranges);
      if (anchor.rawRanges !== undefined) compareRanges('rawRanges', got.rawRanges, anchor.rawRanges);
      const thread = inspection.threads[anchor.threadId];
      if (!thread) add(want.path, anchor.label, 'thread messages unavailable');
      else if (thread.resolved !== anchor.resolved) add(want.path, anchor.label, `thread ${thread.resolved ? 'resolved' : 'open'}, expected ${anchor.resolved ? 'resolved' : 'open'}`);
    }
    for (const comment of doc.comments) {
      if (!want.anchors.some(anchor => anchor.threadId === comment.threadId)) add(want.path, 'unexpected thread', `${comment.state} anchor not seeded by the harness`);
    }
    const unmatched = [...doc.changes];
    for (const suggestion of want.suggestions) {
      const index = unmatched.findIndex(change => change.kind === suggestion.kind && change.text === suggestion.text);
      if (index < 0) { add(want.path, suggestion.label, `tracked ${suggestion.kind} of ${quote(suggestion.text)} missing`); continue; }
      const [got] = unmatched.splice(index, 1);
      if (got.pos !== suggestion.pos) add(want.path, suggestion.label, `tracked ${suggestion.kind} at ${got.pos}, expected ${suggestion.pos}`);
      if (suggestion.kind === 'insert' && doc.text.slice(got.pos, got.pos + got.text.length) !== got.text) add(want.path, suggestion.label, 'inserted text is not at the reported position');
    }
    for (const change of unmatched) add(want.path, 'unexpected suggestion', `tracked ${change.kind} of ${quote(change.text)} at ${change.pos}`);
  }
  if (inspection.unassignedThreadCount !== expected.unassignedThreads) {
    add('(project)', 'unassigned threads', `${inspection.unassignedThreadCount}, expected ${expected.unassignedThreads}`);
  }
  return problems;
}
