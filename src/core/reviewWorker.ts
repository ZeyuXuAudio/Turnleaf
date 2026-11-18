import { isMainThread, parentPort } from 'node:worker_threads';
import { DocState } from './models';
import { Diff, diffText } from './diff';
import { mapDocument } from './ranges';

export interface ReviewInput { doc: DocState; local: string; trackChanges?: boolean; diffs?: Diff[]; }
export function computeReview(input: ReviewInput) {
  const diffs = input.diffs ?? diffText(input.doc.text, input.local).diffs;
  return { diffs, mapping: mapDocument(input.doc, input.local, input.trackChanges, diffs) };
}
if (!isMainThread) parentPort!.on('message', ({ id, input }: { id: number; input: ReviewInput }) => {
  try { parentPort!.postMessage({ id, result: computeReview(input) }); }
  catch (error) { parentPort!.postMessage({ id, error: error instanceof Error ? error.message : 'Comment mapping failed.' }); }
});
