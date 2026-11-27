import * as vscode from 'vscode';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RoundtripApi } from '../src/extension/extension';
import type { ActionResult } from '../src/core/actionLog';
import { SETTLE_MS } from '../src/core/actionLog';
import { ProjectStore } from '../src/core/projectStore';
import { LocalReviewFiles, threadFileName, type ThreadFile } from '../src/core/reviewFiles';
import { normalizeBaseUrl } from '../src/core/http';
import { SessionExpiredError } from '../src/core/errors';
import type { Inspection } from '../src/core/models';
import {
  commentQuote, Detail, errorText, leftoverCounts, leftovers, markers, nameGuard, nothingLeft, projectState, ProjectState,
  stateDifferences, StepFailure, Steps, threadWithFirstMessage, withEditLine, writeResult, MARKER_PREFIX,
} from './roundtripCore';

// Development-host companion for scripts/roundtrip.mjs: the extension leg of the live
// roundtrip test. It drives the real commands (Get latest, Apply, Send) and the local review
// files, checks each write on Overleaf with its own read, and removes what it wrote. The
// result holds steps, outcomes, durations and counts only: no cookie, no document or comment
// text beyond the test's marker strings, no author names.
//
// Phases: `setup` waits for Turnleaf: Sign In; `extension` runs the leg; `cleanup` removes
// any marker left by either leg and compares the project with the state at the start.
const env = process.env;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const real = (path: string) => { try { return realpathSync(path); } catch { return path; } };

function runtime(extension?: vscode.Extension<unknown>) {
  let appVersion: string | undefined;
  try { appVersion = JSON.parse(readFileSync(join(vscode.env.appRoot, 'product.json'), 'utf8')).version; } catch { /* optional */ }
  return { app: vscode.env.appName, appVersion, vscodeApi: vscode.version, platform: `${process.platform}-${process.arch}`, extension: extension?.packageJSON.version };
}

export async function activate(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  const folder = folders?.length === 1 ? folders[0] : undefined;
  if (!folder || !env.TURNLEAF_ROUNDTRIP_WORKSPACE || real(folder.uri.fsPath) !== real(env.TURNLEAF_ROUNDTRIP_WORKSPACE)) return;
  const resultPath = env.TURNLEAF_ROUNDTRIP_RESULT!, phase = env.TURNLEAF_ROUNDTRIP_PHASE ?? 'extension';
  const projectId = env.TURNLEAF_ROUNDTRIP_PROJECT ?? '', runId = env.TURNLEAF_ROUNDTRIP_RUN ?? 'unknown';
  const extension = vscode.extensions.getExtension<RoundtripApi>('zeyuxu.turnleaf');
  const config = () => vscode.workspace.getConfiguration('turnleaf', folder.uri);
  const set = (key: string, value: unknown) => config().update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
  const baseUrl = () => normalizeBaseUrl(config().get<string>('baseUrl', 'https://www.overleaf.com'));
  const base = { phase, runId, startedAt: new Date().toISOString(), runtime: runtime(extension), server: (() => { try { return new URL(baseUrl()).origin; } catch { return 'invalid'; } })() };
  const steps = new Steps('extension');
  let secret: string | undefined;
  const write = async (result: object) => { await writeResult(resultPath, { ...base, ...result, steps: steps.list, finishedAt: new Date().toISOString() }, [secret]); };

  let api: RoundtripApi;
  try {
    api = await extension?.activate() as RoundtripApi;
    if (!api || typeof api.view !== 'function') throw new Error('The extension did not enable its roundtrip hook.');
  } catch (error) { await write({ status: 'failed', message: errorText(error) }); return; }

  // ---- Helpers ----
  const command = async (id: string, arg?: unknown) => await vscode.commands.executeCommand<ActionResult | undefined>(`turnleaf.${id}`, ...arg === undefined ? [] : [arg]);
  const why = (result: ActionResult | undefined) => `${result?.outcome ?? 'no result'}${result?.error ? `: ${result.error}` : ''}`;
  async function until(predicate: () => boolean | Promise<boolean>, label: string, ms = 30_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { if (await predicate()) return; await sleep(200); }
    throw new StepFailure(`Timed out waiting: ${label}.`);
  }
  let paths: string[] = config().get<string[]>('trackedFiles', []);
  const read = async (): Promise<Inspection> => (await api.reader()).inspect(projectId, paths);
  const store = () => new ProjectStore(folder.uri.fsPath, baseUrl(), projectId, paths);
  const reviewPath = (file: string) => new LocalReviewFiles(store()).path(file);
  const view = () => api.view();

  // Get latest, then Apply. The view leaves out a finished preview: one that found the folder
  // up to date, or one that was applied.
  async function getLatestApply(): Promise<Detail> {
    const pulled = await command('pull');
    if (pulled?.outcome !== 'done') throw new StepFailure(`Get latest: ${why(pulled)}`);
    const preview = view().preview;
    if (!preview) { await command('cancelPreview'); return { applied: false, files: 0 }; }
    if (preview.files.some(file => file.conflict) || preview.pictures?.some(picture => picture.conflict)) throw new StepFailure('Get latest found a conflict; the test folder should never have one.');
    await sleep(SETTLE_MS + 150);
    const applied = await command('applyReviewed', { preview: preview.id });
    if (applied?.outcome !== 'done' || view().preview) throw new StepFailure(`Apply: ${why(applied)}${view().preview ? '; the preview is still open' : ''}`);
    return { applied: true, files: preview.files.length, comments: preview.comments?.length ?? 0 };
  }
  // Send once the summary lists something and has settled; a press too soon or on a changed summary is retried.
  async function send(label: string): Promise<Detail> {
    const ready = () => { const o = view().outgoing; return api.settled() && !!o && !o.busy && !o.sendWait && o.files.length + o.comments.length > 0; };
    for (let attempt = 1; attempt <= 4; attempt++) {
      await until(ready, `${label} listed in the outgoing summary`);
      const o = view().outgoing!;
      if (o.blocked) throw new StepFailure(`Send is blocked (${o.blocked.way}).`);
      if (o.unsaved?.length) throw new StepFailure('Send waits for unsaved files.');
      await sleep(SETTLE_MS + 150);
      const result = await command('send');
      if (result?.outcome === 'sent') {
        if (result.verification !== 'verified') throw new StepFailure(`Sent, but Send's own check reported ${result.verification}.`);
        return { rows: result.rows ?? null, attempts: attempt };
      }
      if (!['too-soon-after-summary-change', 'summary-refreshing', 'summary-changed', 'busy'].includes(result?.outcome ?? '')) throw new StepFailure(`Send: ${why(result)}`);
    }
    throw new StepFailure('Send did not go out after 4 attempts.');
  }
  async function editThreadFile(threadId: string, edit: (file: ThreadFile) => void, draftId: string, label: string): Promise<void> {
    const path = await reviewPath(`threads/${threadFileName(threadId)}`);
    if (!existsSync(path)) throw new StepFailure(`The thread file for ${label} is missing.`);
    const file: ThreadFile = JSON.parse(await readFile(path, 'utf8'));
    edit(file);
    await writeFile(path, JSON.stringify(file, null, 2) + '\n');
    await until(() => !!view().drafts?.some(draft => draft.id === draftId), `${label} imported from the thread file`);
  }
  const ownThread = (inspection: Inspection, text: string) => {
    const id = threadWithFirstMessage(inspection, text);
    if (!id) throw new StepFailure('The thread is not on Overleaf.');
    return { id, thread: inspection.threads[id] };
  };

  // Removes every marker on Overleaf (this run's and any earlier run's): rejects the test's
  // suggestions, deletes its threads, then checks that nothing is left.
  async function clean(prefix: string, baseline?: ProjectState): Promise<{ completed: boolean; remaining: Detail; differences: string[] }> {
    await steps.run(`${prefix}get-latest`, async () => ({ detail: await getLatestApply() }));
    let found = leftovers(await read().catch(() => ({ threads: {}, docs: [] } as unknown as Inspection)));
    if (found.suggestions.length) await steps.run(`${prefix}reject-suggestion`, async () => {
      for (const suggestion of found.suggestions) {
        await until(() => !!view().suggestionRows?.some(row => row.id === suggestion.id), 'the suggestion shown in the editor');
        const decided = await command('rejectChange', { path: suggestion.path, value: suggestion.id });
        if (decided?.outcome !== 'done') throw new StepFailure(`Reject: ${why(decided)}`);
      }
      const sent = await send('the rejection');
      const after = leftovers(await read());
      if (after.suggestions.length) throw new StepFailure('The suggestion is still on Overleaf after Send.', { suggestions: after.suggestions.length });
      return { detail: { ...sent, rejected: found.suggestions.length } };
    });
    if (found.threads.length) await steps.run(`${prefix}delete-thread`, async () => {
      for (const [n, threadId] of found.threads.entries()) {
        const id = `${markers(runId, 'extension').id}-delete-${n + 1}`;
        // deleteThread must be the thread's only edit.
        await editThreadFile(threadId, file => { file.localEdits = [{ id, action: 'deleteThread' }]; }, id, 'the thread deletion');
      }
      api.answerConfirmation('Send');
      const sent = await send('the thread deletion');
      const after = leftovers(await read());
      if (after.threads.length) throw new StepFailure('A test thread is still on Overleaf after Send.', { threads: after.threads.length });
      return { detail: { ...sent, deleted: found.threads.length } };
    });
    found = leftovers(await read());
    const remaining = leftoverCounts(found);
    let differences: string[] = [];
    await steps.run(`${prefix}verify`, async () => {
      const now = projectState(await read());
      differences = baseline ? stateDifferences(baseline, now) : [];
      if (!nothingLeft(found)) throw new StepFailure(`Left on Overleaf: ${found.threads.length} thread(s), ${found.suggestions.length} suggestion(s), ${found.directText.length} file(s) with a marker in their text.`, remaining);
      if (differences.length) throw new StepFailure(`The project differs from its state at the start: ${differences.join('; ')}.`);
      return { detail: { sameAsStart: !!baseline } };
    });
    return { completed: nothingLeft(found) && !differences.length && !!baseline, remaining, differences };
  }

  // ---- Phases ----
  if (phase === 'setup') {
    void vscode.window.showInformationMessage('Roundtrip test setup: run Turnleaf: Sign In. This window closes once you are signed in.', 'Sign In')
      .then(choice => { if (choice) void vscode.commands.executeCommand('turnleaf.signIn'); });
    for (;;) {
      if (api.snapshot().signedInAt && await api.sessionStored()) {
        void vscode.window.showInformationMessage('Roundtrip test setup complete. Closing the window.');
        await write({ status: 'ready' }); return;
      }
      await sleep(1000);
    }
  }

  try {
    if (env.TURNLEAF_ROUNDTRIP_FIXTURE_COOKIE && !await api.sessionStored()) await api.signInLocal(env.TURNLEAF_ROUNDTRIP_FIXTURE_COOKIE);
    if (!await api.sessionStored()) { await write({ status: 'setup-required' }); return; }
    // 1. The name guard, before anything is written.
    let projects;
    try { projects = await api.projects(); }
    catch (error) { if (error instanceof SessionExpiredError) { await write({ status: 'session-expired' }); return; } throw error; }
    let guard = nameGuard(projectId, projects);
    if (!guard.passed) { await write({ status: 'refused', guard }); return; }
    if (phase === 'extension') {
      const sources = await (await api.reader()).listSourceFiles(projectId);
      paths = sources.paths.filter(path => /\.(tex|bib)$/i.test(path));
      if (!paths.length) throw new StepFailure('The test project has no .tex or .bib file.');
    }
    const start = await read();
    guard = nameGuard(projectId, projects, start.projectName);
    if (!guard.passed) { await write({ status: 'refused', guard }); return; }
    secret = (await api.reader()).sessionCookie;
    const trackChanges = start.trackChanges === true ? 'on' : start.trackChanges === false ? 'off' : 'unknown';

    if (phase === 'cleanup') {
      const baseline: ProjectState | undefined = env.TURNLEAF_ROUNDTRIP_BASELINE ? JSON.parse(env.TURNLEAF_ROUNDTRIP_BASELINE) : undefined;
      const cleanup = await clean('final-cleanup-', baseline);
      await write({ status: 'done', guard, trackChanges, cleanup });
      return;
    }

    // 2. Link (as Turnleaf: Link Project does once a project is chosen), Get latest → Apply.
    const linked = await steps.run('link', async () => {
      await set('projectId', projectId); await set('trackedFiles', paths);
      await set('allowWrites', true); await set('localReviewFiles', true);
      await until(() => view().linked === true, 'the folder linked');
      return { value: true, detail: { files: paths.length } };
    });
    const applied = linked && await steps.run('get-latest-apply', async () => {
      const detail = await getLatestApply();
      for (const doc of start.docs) if (await readFile(join(folder.uri.fsPath, doc.path), 'utf8') !== doc.text) throw new StepFailure(`${doc.path} differs from Overleaf after Apply.`);
      if (!existsSync(await reviewPath('REVIEW.md'))) await command('openReviewFiles');
      await until(async () => existsSync(await reviewPath('REVIEW.md')), 'the local review files');
      return { value: true, detail };
    });
    const earlier = leftovers(start);
    let baseline: ProjectState | undefined, leftoversAtStart: Detail | undefined;
    let cleanup: Awaited<ReturnType<typeof clean>> | undefined, cliSessionSaved = false;
    if (applied) {
      // Markers from an earlier, interrupted run are removed first, so the run starts clean.
      if (!nothingLeft(earlier)) {
        leftoversAtStart = leftoverCounts(earlier);
        const before = await clean('earlier-leftovers-');
        if (!before.completed && Object.values(before.remaining).some(Boolean)) throw new StepFailure('Leftovers of an earlier run could not be removed.');
      }
      baseline = projectState(await read());
      if (env.TURNLEAF_ROUNDTRIP_CLI_SESSION) { await api.saveSessionFile(env.TURNLEAF_ROUNDTRIP_CLI_SESSION); cliSessionSaved = true; }
      const m = markers(runId, 'extension');
      try {
        // 3. A new comment through review/new/, then a reply and a resolution through its thread file.
        const created = await steps.run('comment-new', async () => {
          const doc = start.docs.find(doc => doc.path.endsWith('.tex') && commentQuote(doc.text)) ?? start.docs.find(doc => commentQuote(doc.text));
          if (!doc) throw new StepFailure('No line of at least 8 characters occurs exactly once in the selected files.');
          const id = `${m.id}-comment`;
          await writeFile(await reviewPath(`new/${id}.json`), JSON.stringify({ id, path: doc.path, quote: commentQuote(doc.text), text: m.comment }, null, 2) + '\n');
          await until(() => !!view().drafts?.some(draft => draft.kind === 'createThread' && draft.id === id), 'the new comment imported from review/new');
          const sent = await send('the new comment');
          const after = await read(), { id: threadId } = ownThread(after, m.comment);
          const anchor = after.docs.flatMap(d => d.comments).find(anchor => anchor.threadId === threadId);
          if (anchor?.state !== 'placed') throw new StepFailure(`The comment is on Overleaf but its anchor is ${anchor?.state ?? 'missing'}.`);
          return { value: threadId, detail: { ...sent, anchor: anchor.state } };
        });
        const replied = created && await steps.run('comment-reply', async () => {
          const id = `${m.id}-reply`;
          await editThreadFile(created, file => { file.localEdits.push({ id, action: 'reply', text: m.reply }); }, id, 'the reply');
          const sent = await send('the reply');
          const { thread } = ownThread(await read(), m.comment);
          if (!thread.messages.some(message => message.text === m.reply)) throw new StepFailure('The reply is not on Overleaf.');
          return { value: true, detail: { ...sent, messages: thread.messages.length } };
        });
        if (replied) await steps.run('comment-resolve', async () => {
          const id = `${m.id}-resolve`;
          await editThreadFile(created, file => { file.localEdits.push({ id, action: 'resolve' }); }, id, 'the resolution');
          const sent = await send('the resolution');
          if (!ownThread(await read(), m.comment).thread.resolved) throw new StepFailure('The thread is not resolved on Overleaf.');
          return { detail: { ...sent, resolved: true } };
        });
        // 4. One text edit, which must arrive as a suggestion. Track Changes is never turned on here.
        if (trackChanges !== 'on') steps.skip('suggestion-edit', `track-changes-${trackChanges}`);
        else await steps.run('suggestion-edit', async () => {
          const path = paths.find(path => path.endsWith('.tex')) ?? paths[0];
          const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, path));
          const edit = new vscode.WorkspaceEdit();
          edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), withEditLine(document.getText(), m.edit));
          if (!await vscode.workspace.applyEdit(edit) || !await document.save()) throw new StepFailure('The edit could not be saved.');
          await until(() => !!view().outgoing?.files.some(file => file.path === path), 'the edit listed in the outgoing summary');
          const sent = await send('the edit');
          const doc = (await read()).docs.find(doc => doc.path === path)!, text = m.edit.replace(/^%\s*/, '');
          const suggested = doc.changes.some(change => change.kind === 'insert' && change.text.includes(text));
          if (!suggested) throw new StepFailure(doc.text.includes(text) ? 'The edit reached Overleaf as a direct change, not as a suggestion.' : 'The edit is not on Overleaf.', { arrivedAs: doc.text.includes(text) ? 'direct' : 'missing' });
          return { detail: { ...sent, arrivedAs: 'suggestion' } };
        });
      } finally {
        // 5. Cleanup, also after a failed step.
        cleanup = await clean('cleanup-', baseline);
      }
    }
    await write({ status: 'done', guard, trackChanges, baseline: baseline ?? null, leftoversAtStart: leftoversAtStart ?? null, cliSessionSaved,
      cleanup: cleanup ?? { completed: !applied, remaining: null, differences: [] }, markerPrefix: MARKER_PREFIX });
  } catch (error) {
    await write({ status: 'failed', message: errorText(error) });
  }
}
