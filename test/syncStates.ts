import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectStore } from '../src/core/projectStore';
import { ReviewWorkflow, SyncService, remoteTexts } from '../src/core/folderWorkflow';
import { OverleafReader } from '../src/core/overleaf';
import { readSaved } from '../src/core/savedFiles';
import { fixtureCookie, startFixtureServer } from './fixtureServer';

/**
 * The states of the Sync State Map, judged for main.tex. Link states have no baseline yet; Sync
 * states start from a recorded baseline and then change one or both sides.
 */
export type StateName =
  | 'link-neither-side' | 'link-local-only' | 'link-overleaf-only' | 'link-same-both' | 'link-different-both'
  | 'sync-in-sync' | 'sync-local-ahead' | 'sync-overleaf-ahead' | 'sync-both-merge-clean' | 'sync-both-overlap';

export const stateText = {
  base: 'Rain was excluded.\n\nMethods.\n\nResults.\n\nDrift: 0.64.\n',
  localEdit: 'Rain was excluded.\n\nMethods.\n\nResults, with my numbers.\n\nDrift: 0.64.\n',
  remoteEdit: 'Rain was excluded.\n\nMethods, revised by a coauthor.\n\nResults.\n\nDrift: 0.64.\n',
  merged: 'Rain was excluded.\n\nMethods, revised by a coauthor.\n\nResults, with my numbers.\n\nDrift: 0.64.\n',
  localOverlap: 'Rain was excluded.\n\nMethods.\n\nResults.\n\nDrift: 0.60.\n',
  remoteOverlap: 'Rain was excluded.\n\nMethods.\n\nResults.\n\nDrift: 0.58.\n',
  differentLocal: 'Existing local work.\n',
  localDraft: 'A section drafted locally.\n',
};
/** A selected file that the fixture's Overleaf project does not have. */
export const absentPath = 'draft.tex';
const projectPaths = ['main.tex', 'references.bib'];

// suggestion: main.tex carries a reviewer's suggested insertion of "Methods".
export async function arrangeState(name: StateName, options: { trackChanges?: boolean; mainText?: string; suggestion?: boolean } = {}) {
  const fixture = await startFixtureServer({ writable: true, trackChanges: options.trackChanges ?? false });
  const root = await mkdtemp(join(tmpdir(), `overleaf-${name}-`));
  const mainText = options.mainText ?? stateText.base;
  fixture.replies.modern[0] = { content: mainText, comments: mainText.startsWith('Rain') ? [{ id: 'c1', ranges: [{ pos: 0, length: 4 }] }] : [],
    trackedChanges: options.suggestion ? [{ range: { pos: mainText.indexOf('Methods'), length: 7 }, tracking: { type: 'insert', userId: 'reviewer', ts: '2026-10-19T12:00:01Z' } }] : [] };
  const reader = new OverleafReader(fixture.baseUrl, fixtureCookie);
  const paths = name === 'link-neither-side' || name === 'link-local-only' ? [...projectPaths, absentPath] : projectPaths;
  const inspection = await reader.inspect('test-project', projectPaths), remote = remoteTexts(inspection);
  const state = new ProjectStore(root, fixture.baseUrl, 'test-project', paths), sync = new SyncService(state, reader), workflow = new ReviewWorkflow(sync);
  const put = (path: string, text: string) => writeFile(join(root, path), text);
  const remoteEdit = (text: string) => { fixture.replies.modern[0].content = text; fixture.replies.modern[1]++; };

  if (name !== 'link-overleaf-only') for (const [path, text] of Object.entries(remote)) await put(path, text);
  if (name === 'link-local-only') await put(absentPath, stateText.localDraft);
  if (name === 'link-different-both') await put('main.tex', stateText.differentLocal);
  if (name.startsWith('sync-')) {
    await workflow.apply(await workflow.preparePull(), () => true);
    if (name === 'sync-local-ahead' || name === 'sync-both-merge-clean') await put('main.tex', stateText.localEdit);
    if (name === 'sync-overleaf-ahead' || name === 'sync-both-merge-clean') remoteEdit(stateText.remoteEdit);
    if (name === 'sync-both-overlap') { await put('main.tex', stateText.localOverlap); remoteEdit(stateText.remoteOverlap); }
  }
  const startRequests = fixture.requests.length;
  return {
    name, root, fixture, reader, paths, state, sync, workflow, inspection, remote, put, remoteEdit,
    local: () => readSaved(root, paths, true),
    /** Requests since the state was arranged that would change Overleaf. */
    writes: () => fixture.requests.slice(startRequests).filter(r => (r.method !== 'GET' && r.path.startsWith('/project/')) || r.packet?.includes('applyOtUpdate')),
    stateFile: () => readFile(join(root, '.turnleaf/projects', state.key, 'state.json'), 'utf8').catch(() => undefined),
    close: async () => { await fixture.close(); await rm(root, { recursive: true, force: true }); },
  };
}
