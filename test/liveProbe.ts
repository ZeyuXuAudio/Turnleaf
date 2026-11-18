import * as vscode from 'vscode';
import { readFileSync, realpathSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LiveProbeApi } from '../src/extension/extension';
import type { CommandOutcome, ErrorSummary } from '../src/core/probe';
import type { Project } from '../src/core/models';

// Development-host companion for scripts/live.mjs. It runs the real commands and writes
// only the sanitized counts and shapes exposed by the extension's probe hook: no cookie,
// document text, comment text, author names or IDs.
const env = process.env;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const real = (path: string) => { try { return realpathSync(path); } catch { return path; } };

function runtime(extension?: vscode.Extension<unknown>) {
  let appVersion: string | undefined;
  try { appVersion = JSON.parse(readFileSync(join(vscode.env.appRoot, 'product.json'), 'utf8')).version; } catch { /* optional */ }
  return { app: vscode.env.appName, appVersion, vscodeApi: vscode.version, extensionHostNode: process.versions.node,
    platform: `${process.platform}-${process.arch}`, extension: extension?.packageJSON.version };
}

export async function activate(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  const folder = folders?.length === 1 ? folders[0] : undefined;
  // Cursor may open extra windows; only the window with the probe workspace runs.
  if (!folder || !env.TURNLEAF_LIVE_WORKSPACE || real(folder.uri.fsPath) !== real(env.TURNLEAF_LIVE_WORKSPACE)) return;
  const resultPath = env.TURNLEAF_LIVE_RESULT!, phase = env.TURNLEAF_LIVE_PHASE;
  const extension = vscode.extensions.getExtension<LiveProbeApi>('zeyuxu.turnleaf');
  const config = () => vscode.workspace.getConfiguration('turnleaf', folder.uri);
  const server = () => { try { return new URL(config().get<string>('baseUrl', '')).origin; } catch { return 'invalid'; } };
  const base = { probe: 'turnleaf-live', phase, startedAt: new Date().toISOString(), runtime: runtime(extension), server: server() };
  const write = async (result: object) => {
    await writeFile(resultPath + '.partial', JSON.stringify({ ...base, ...result, finishedAt: new Date().toISOString() }, null, 2) + '\n');
    await rename(resultPath + '.partial', resultPath);
  };
  try {
    const api = await extension?.activate() as LiveProbeApi | undefined;
    if (!api || typeof api.snapshot !== 'function') throw new Error('The extension did not enable its live probe hook.');
    await (phase === 'setup' ? setup : inspect)(api);
  } catch (error) {
    await write({ status: 'failed', message: error instanceof Error ? error.message : 'Probe failed.' });
  }

  async function setup(api: LiveProbeApi): Promise<void> {
    const command = (id: string) => (choice?: string) => { if (choice) void vscode.commands.executeCommand(id); };
    void vscode.window.showInformationMessage('Live probe setup: run Turnleaf: Sign In, then Turnleaf: Link Project and choose its files if no project is linked. This window closes when both are done.', 'Sign In').then(command('turnleaf.signIn'));
    let prompted = false;
    for (;;) {
      const { signedInAt } = api.snapshot();
      // Linking opens Choose files; the project counts as linked once files are chosen.
      const linked = Boolean(config().get('projectId')) && config().get<string[]>('trackedFiles', []).length > 0;
      if (signedInAt && linked && await api.sessionStored()) {
        void vscode.window.showInformationMessage('Live probe setup complete. Closing the window.');
        await write({ status: 'ready', session: { signedInAt }, projectLinked: true });
        return;
      }
      if (signedInAt && !linked && !prompted) {
        prompted = true;
        void vscode.window.showInformationMessage('Signed in. Now run Turnleaf: Link Project.', 'Link Project').then(command('turnleaf.linkProject'));
      }
      await sleep(1000);
    }
  }

  // Runs the real Inspect command once with the current settings and returns its sanitized outcome.
  async function inspectOnce(api: LiveProbeApi): Promise<CommandOutcome> {
    const before = api.snapshot().outcomes.length;
    await vscode.commands.executeCommand('turnleaf.inspectProject');
    const outcome = api.snapshot().outcomes.slice(before).filter(item => item.command === 'turnleaf.inspectProject').at(-1);
    if (!outcome) throw new Error('Turnleaf: Inspect Project did not run.');
    return outcome;
  }

  async function inspect(api: LiveProbeApi): Promise<void> {
    const storedBeforeRun = await api.sessionStored(), linkedId = config().get<string>('projectId', '');
    if (!storedBeforeRun || !linkedId || !config().get<string[]>('trackedFiles', []).length) {
      await write({ status: 'setup-required', session: { storedBeforeRun, accepted: null }, projectLinked: Boolean(linkedId) });
      return;
    }
    // The project page answers part of Q6 (`ol-user_id`) and resolves the projects to check for Q2.
    let projects: Project[] | undefined, projectListError: ErrorSummary | undefined;
    try { projects = await api.projects(); }
    catch (error) { projectListError = error instanceof Error && 'code' in error ? { code: String(error.code), message: error.message } : { code: 'unexpected', message: 'Project list failed.' }; }
    if (projectListError?.code === 'session-expired') {
      await write({ status: 'session-expired', session: { storedBeforeRun, accepted: false }, projectLinked: true, projectList: { error: projectListError } });
      return;
    }
    const outcome = await inspectOnce(api);
    const snapshot = api.snapshot(), join = outcome.joinProject;
    const results = await checkProjects(api, projects, linkedId);
    const outcomes = [outcome, ...results.flatMap(result => result.outcomes)];
    // Only an expired-session error proves rejection; other errors leave the session state unknown.
    const accepted = outcomes.some(item => item.error?.code === 'session-expired') ? false : !outcome.error ? true : null;
    const failed = Boolean(outcome.error) || results.some(result => result.entry.status !== 'passed');
    await write({
      status: accepted === false ? 'session-expired' : failed ? 'failed' : 'passed',
      session: { storedBeforeRun, accepted }, projectLinked: true,
      inspect: { durationMs: outcome.durationMs, error: outcome.error ?? null },
      q6: {
        userIdMetaTag: snapshot.projectPage?.userIdMetaTag ?? null, userIdIsObjectId: snapshot.projectPage?.userIdIsObjectId ?? null, trackChangesState: join?.trackChangesState ?? null,
        trackChangesHasUserKey: join?.trackChangesHasUserKey ?? null, trackChangesHasOwnerKey: join?.trackChangesHasOwnerKey ?? null,
      },
      q2: otTypeTotals([outcome, ...results.map(result => result.final)]),
      inspection: outcome.inspection ?? null, joinProject: join ?? null,
      ...projectListError && { projectList: { error: projectListError } },
      ...results.length && { projects: results.map(result => result.entry) },
    });
  }

  // Q2: inspect further projects named on the command line (or the most recently updated ones),
  // reporting each by its position only. The linked project setting is restored afterwards.
  async function checkProjects(api: LiveProbeApi, projects: Project[] | undefined, linkedId: string) {
    const selectors: string[] = JSON.parse(env.TURNLEAF_LIVE_PROJECT_LIST || '[]');
    const recent = Number(env.TURNLEAF_LIVE_RECENT || 0);
    const files: string[] | undefined = env.TURNLEAF_LIVE_FILE_LIST ? JSON.parse(env.TURNLEAF_LIVE_FILE_LIST) : undefined;
    const targets: { source: 'argument' | 'recent'; id?: string; status?: string }[] = selectors.map(selector => ({ source: 'argument' as const, ...resolve(selector, projects) }));
    if (recent > 0 && projects) {
      const chosen = new Set(targets.map(target => target.id).concat(linkedId));
      const sorted = projects.filter(project => !chosen.has(project.id)).sort((a, b) => String(b.lastUpdated ?? '').localeCompare(String(a.lastUpdated ?? '')));
      for (const project of sorted.slice(0, recent)) targets.push({ source: 'recent', id: project.id });
    }
    if (!targets.length) return [];
    const settings = config().inspect<unknown>('projectId')?.workspaceFolderValue, tracked = config().inspect<unknown>('trackedFiles')?.workspaceFolderValue;
    const configured = config().get<string[]>('trackedFiles', []);
    const results: { entry: Record<string, unknown>; outcomes: CommandOutcome[]; final?: CommandOutcome }[] = [];
    const set = async (key: string, value: unknown) => config().update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
    try {
      for (const [index, target] of targets.entries()) {
        const entry: Record<string, unknown> = { label: `#${index + 1}`, source: target.source };
        if (!target.id) { results.push({ entry: { ...entry, status: target.status }, outcomes: [] }); continue; }
        if (target.id === linkedId) { results.push({ entry: { ...entry, status: 'passed', sameAsLinked: true }, outcomes: [] }); continue; }
        await set('projectId', target.id);
        await set('trackedFiles', files ?? configured);
        const outcomes = [await inspectOnce(api)];
        let fallback = false;
        // Projects without the tracked files are read through their root doc instead.
        const first = outcomes[0], rootDoc = first.joinProject?.rootDoc;
        if (!first.error && first.inspection && !first.inspection.docs.length && rootDoc && !(files ?? configured).includes(rootDoc)) {
          await set('trackedFiles', [rootDoc]);
          outcomes.push(await inspectOnce(api));
          fallback = true;
        }
        const final = outcomes.at(-1)!;
        results.push({ outcomes, final, entry: { ...entry, status: final.error ? 'failed' : 'passed', trackedFiles: fallback ? 'root doc' : files ? 'override' : 'configured',
          durationMs: outcomes.reduce((total, item) => total + item.durationMs, 0), error: final.error ?? null,
          docs: final.inspection?.docs.map(doc => ({ path: doc.path, otType: doc.otType, version: doc.version })) ?? [],
          missingFiles: final.inspection?.missingFiles ?? null,
          trackChangesState: first.joinProject?.trackChangesState ?? null, trackChangesHasUserKey: first.joinProject?.trackChangesHasUserKey ?? null,
          trackChangesHasOwnerKey: first.joinProject?.trackChangesHasOwnerKey ?? null, trackChangesShape: first.joinProject?.trackChangesFields.trackChangesState ?? null } });
      }
    } finally {
      await set('projectId', settings);
      await set('trackedFiles', tracked);
    }
    return results;
  }
}

function resolve(selector: string, projects: Project[] | undefined): { id?: string; status?: string } {
  if (projects?.some(project => project.id === selector) || /^[0-9a-f]{24}$/i.test(selector)) return { id: selector };
  if (!projects) return { status: 'project-list-unavailable' };
  for (const same of [(name: string) => name === selector, (name: string) => name.toLowerCase() === selector.toLowerCase()]) {
    const matches = projects.filter(project => same(project.name));
    if (matches.length === 1) return { id: matches[0].id };
    if (matches.length > 1) return { status: 'ambiguous' };
  }
  return { status: 'not-found' };
}

function otTypeTotals(outcomes: (CommandOutcome | undefined)[]) {
  const docs: Record<string, number> = {};
  let projects = 0;
  for (const outcome of outcomes) {
    if (!outcome?.inspection) continue;
    projects++;
    for (const doc of outcome.inspection.docs) docs[doc.otType] = (docs[doc.otType] ?? 0) + 1;
  }
  return { projects, docs };
}
