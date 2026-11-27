import * as vscode from 'vscode';
import { createHash, randomUUID } from 'node:crypto';
import { OverleafReader } from '../core/overleaf';
import { normalizeBaseUrl } from '../core/http';
import { validateTrackedFiles } from '../core/docState';
import { Inspection, Project } from '../core/models';
import { anchorStateLabel, inspectionCounts, renderInspection } from '../core/report';
import { safeError, SessionExpiredError, SyncError } from '../core/errors';
import { ProbeRecorder, ProbeSnapshot } from '../core/probe';
import { installWorkspace, CommandMode } from './workspace';
import { progress, currentOperation } from '../core/operation';
import { ActionLog, describe, operationLabel, pressTag, Press, ActionResult, SEND_COMMANDS } from '../core/actionLog';
import { CommandRunner, FinishedRecord } from '../core/commands';
import { browserSignIn, closeLeftoverSignInBrowser, closeSignInBrowsers, findBrowser, LeftoverSignInWindowError } from '../core/browserSignIn';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectView } from './panel';

class InspectionDocuments implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  private readonly contents = new Map<string, string>();
  add(path: string, text: string): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: 'overleaf-inspection', path: `/${randomUUID()}/${path}` });
    this.contents.set(uri.toString(), text);
    return uri;
  }
  provideTextDocumentContent(uri: vscode.Uri): string { return this.contents.get(uri.toString()) ?? 'Inspection cleared. Run Turnleaf: Inspect Project again.'; }
  clear(): void {
    const uris = [...this.contents.keys()];
    this.contents.clear();
    uris.forEach(uri => this.changed.fire(vscode.Uri.parse(uri)));
  }
  dispose(): void { this.clear(); this.changed.dispose(); }
}

interface Scope { folder: vscode.WorkspaceFolder; baseUrl: string; projectId: string; trackedFiles: string[]; }
export interface TestApi {
  signIn(cookie: string): Promise<void>;
  inspect(): Promise<Inspection>;
  openFile(path: string): Promise<vscode.Uri>;
  sessionStored(): Promise<boolean>;
  runtime(): { node: string; editor: string; app: string };
  refreshLocal(): Promise<void>;
  /** `startup`: as when the window opens, including the first read. */
  restoreLocal(startup?: boolean): Promise<void>;
  reviewSnapshot(): { threadCount: number; disposedInUse: number; highlights: boolean; decorations: { comments: number; insertions: number; deletions: number }; labels: string[]; panel: boolean; sidebar: boolean; cached: boolean; state: string; activePath?: string; preview?: { id: string; kind: string; stale?: string; complete?: string; files: number } };
  /** True once the outgoing summary reflects the current files and drafts. */
  summarySettled(): boolean;
  reviewThread(id: string): vscode.CommentThread | undefined;
  reviewCommentingRanges(document: vscode.TextDocument): vscode.Range[];
  reviewView(): ProjectView;
  /** The status line and connection of every panel render so far. */
  reviewRenders(): { state: string; connected: boolean }[];
  /** When the summary shown last changed. */
  summaryChangedAt(): number | undefined;
  /** The answer the next Send confirmation gets, in place of the modal. */
  answerConfirmation(answer: string | undefined): void;
  /** A message as the project view posts it (a press, a release, a command). */
  viewMessage(surface: 'sidebar' | 'panel', message: unknown): void;
  /** Every line written to the Turnleaf output channel. */
  outputLines(): string[];
  /** Resolves once every press-record line queued so far is written. */
  actionsWritten(): Promise<void>;
}
export interface LiveProbeApi {
  sessionStored(): Promise<boolean>;
  // Read-only project list for the probe's project selection; names and IDs stay in memory.
  projects(): Promise<Project[]>;
  snapshot(): ProbeSnapshot;
}

// Closes a sign-in window that is still open, so that no browser keeps running
// on the sign-in profile after the editor (or its extension host) stops.
export function deactivate(): Promise<void> { return closeSignInBrowsers(); }

export function activate(context: vscode.ExtensionContext): TestApi | LiveProbeApi | undefined {
  // A log channel: VS Code puts the time on every line and offers a level filter.
  const output = vscode.window.createOutputChannel('Turnleaf', { log: true });
  const version = String(context.extension.packageJSON.version);
  // The editor test reads back what the output channel was given.
  const outputLines: string[] = [];
  if (context.extensionMode === vscode.ExtensionMode.Test) for (const level of ['appendLine', 'info', 'warn', 'error'] as const) {
    const original = output[level].bind(output) as (text: string) => void;
    (output as unknown as Record<string, (text: string) => void>)[level] = text => { outputLines.push(text); original(text); };
  }
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  const documents = new InspectionDocuments();
  const comments = vscode.comments.createCommentController('turnleaf', 'Overleaf inspection');
  const clients = new Map<string, OverleafReader>();
  const openedDocuments = new Map<string, vscode.Uri>();
  const threads: vscode.CommentThread[] = [];
  let latest: Inspection | undefined;
  let ready: Promise<unknown> = Promise.resolve();
  // The press record: `.turnleaf/projects/<key>/actions.jsonl` beside the output channel.
  const log = new ActionLog({ version, session: vscode.env.sessionId, pid: process.pid, app: vscode.env.appName, editor: vscode.version }, message => output.warn(message));
  const modes = new Map<string, CommandMode | undefined>();
  // Commands that only move the view (thread opens, view toggles) go to the output channel only.
  const filed = (command: string) => modes.get(`turnleaf.${command}`) !== 'quiet' || command === 'saveAll';
  const target = (command: string) => filed(command) ? workspace.actionTarget() : undefined;
  const short = (id: string) => id.replace(/^turnleaf\./, '');
  const title = (command: string, surface: string | undefined, press: boolean) => `${operationLabel(command)} ${press ? 'press' : 'command'} (${surface ?? 'command'}, ${version})`;
  const write = (line: string, result: ActionResult) => result.outcome === 'failed' ? output.warn(line) : output.info(line);
  const runner = new CommandRunner({
    ready: () => ready,
    progress: (mode, task) => vscode.window.withProgress({ location: mode === 'window' ? vscode.ProgressLocation.Window : vscode.ProgressLocation.Notification, title: 'Turnleaf', cancellable: mode !== 'window' }, async (progress, token) => {
      const abort = new AbortController(), subscription = token.onCancellationRequested(() => abort.abort());
      try { return await task(abort.signal, message => progress.report({ message })); }
      finally { subscription.dispose(); }
    }),
    received(record) {
      const command = short(record.command);
      // Its finished line goes where this one went: a command that links the project (the first Get latest) stays out of the file.
      record.target = target(command);
      void log.write(record.target, { event: 'received', seq: record.seq, command, surface: record.surface });
      workspace.commandReceived(command);
    },
    finished(record: FinishedRecord) {
      const command = short(record.command);
      probe?.finished(record.command, new Date(record.received), record.error);
      write(`${title(command, record.surface, record.seq !== undefined)} — ${describe(record.result, record.durationMs)}${record.waitMs >= 200 ? ` (waited ${record.waitMs} ms first)` : ''}`, record.result);
      void log.write(record.target, { event: 'finished', seq: record.seq, command, surface: record.surface, durationMs: record.durationMs, waitMs: record.waitMs, ...record.result });
      workspace.commandFinished(command, record.result);
    },
    failed(id, error, quiet) {
      if (!quiet && (error instanceof SessionExpiredError || error instanceof Error && error.cause instanceof SessionExpiredError)) {
        clients.clear(); workspace.setSessionState('expired');
        void vscode.window.showErrorMessage('Overleaf session expired', 'Sign in again').then(choice => { if (choice) void vscode.commands.executeCommand('turnleaf.signIn'); });
      } else if (!(error instanceof SyncError && error.code === 'cancelled')) void vscode.window.showErrorMessage(safeError(error), { modal: !quiet && error instanceof SyncError && error.code === 'push' });
    },
    // Send and Send undo say it in the summary instead of a pop-up.
    busy(id) { if (!SEND_COMMANDS.has(short(id))) void vscode.window.showInformationMessage('An Overleaf operation is already running.'); },
    changed: () => workspace.operationChanged(),
  });
  const presses = {
    pressed(press: Press) { press.target = target(press.command); void log.write(press.target, { event: 'press', seq: press.seq, command: press.command, surface: press.surface, disabled: press.disabled, detail: press.detail }); },
    ended(press: Press, result: ActionResult) {
      write(`${title(press.command, press.surface, true)} — ${describe(result)}`, result);
      void log.write(press.target, { event: 'press-ended', seq: press.seq, command: press.command, surface: press.surface, ...result });
    },
  };
  // Sanitized counts and shapes for scripts/live.mjs; never enabled in an installed extension.
  const probe = context.extensionMode === vscode.ExtensionMode.Development && process.env.TURNLEAF_LIVE_PROBE === '1' ? new ProbeRecorder() : undefined;
  status.text = 'Overleaf: ready';
  status.command = 'turnleaf.showOverview';
  status.tooltip = 'Open Overleaf project controls and review changes.';
  status.show();
  const secretKey = (baseUrl: string) => `turnleaf.session.${createHash('sha256').update(baseUrl).digest('hex')}`;
  const clear = () => {
    workspace.clear();
    latest = undefined;
    openedDocuments.clear();
    threads.splice(0).forEach(thread => thread.dispose());
    documents.clear();
    status.text = 'Overleaf: ready';
  };
  context.subscriptions.push(output, status, documents, comments, { dispose() { runner.abort(); } },
    vscode.workspace.registerTextDocumentContentProvider('overleaf-inspection', documents),
    vscode.workspace.onDidChangeConfiguration(event => { if (['baseUrl', 'projectId', 'trackedFiles'].some(key => event.affectsConfiguration(`turnleaf.${key}`))) { clients.clear(); clear(); } }),
    context.secrets.onDidChange(() => clients.clear()));

  async function scope(): Promise<Scope> {
    if (!vscode.workspace.isTrusted) throw new SyncError('Trust this workspace before connecting to Overleaf.', 'trust');
    const folders = vscode.workspace.workspaceFolders;
    const folder = folders?.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Choose the workspace to link to Overleaf' });
    if (!folder) throw new SyncError('Open a local workspace folder first.', 'configuration');
    const config = vscode.workspace.getConfiguration('turnleaf', folder.uri);
    return { folder, baseUrl: normalizeBaseUrl(config.get<string>('baseUrl', 'https://www.overleaf.com')),
      projectId: config.get<string>('projectId', ''), trackedFiles: validateTrackedFiles(config.get('trackedFiles', []), { allowEmpty: true }) };
  }
  async function reader(s: Scope): Promise<OverleafReader> {
    const cached = clients.get(s.baseUrl);
    if (cached) { workspace.setSessionState('valid'); return cached; }
    const cookie = await context.secrets.get(secretKey(s.baseUrl));
    if (!cookie) throw new SessionExpiredError();
    const client = new OverleafReader(s.baseUrl, cookie, probe);
    clients.set(s.baseUrl, client);
    workspace.setSessionState('valid');
    return client;
  }
  // One private browser profile per server, outside every workspace.
  const signInProfile = (baseUrl: string) => join(context.globalStorageUri.fsPath, 'sign-in', createHash('sha256').update(new URL(baseUrl).origin).digest('hex').slice(0, 16));
  async function signIn(cookie?: string): Promise<void> {
    if (cookie !== undefined) return signInWithCookie(cookie);
    const s = await scope();
    const executable = findBrowser(vscode.workspace.getConfiguration('turnleaf').get<string>('browserPath'));
    if (!executable) {
      const choice = await vscode.window.showWarningMessage('No Chrome, Edge, Brave or Chromium browser was found for signing in.', { detail: 'Set turnleaf.browserPath to a Chromium-based browser, or paste a session cookie instead.' }, 'Paste session cookie');
      if (choice) await signInWithCookie();
      return;
    }
    progress('Sign in to Overleaf in the browser window. It closes once you are signed in.');
    const profileDir = signInProfile(s.baseUrl);
    let validated: { client: OverleafReader; projects: Project[] } | undefined;
    const attempt = () => browserSignIn({ baseUrl: s.baseUrl, executable, profileDir, signal: currentOperation()?.signal, log: line => output.appendLine(line),
      validate: async value => {
        const client = new OverleafReader(s.baseUrl, value, probe);
        try { validated = { client, projects: await client.signIn() }; return true; }
        catch (error) { if (error instanceof SessionExpiredError) return false; throw error; }
      } });
    try { await attempt(); }
    catch (error) {
      // The browser opened but ignores the DevTools pipe, typically because an
      // administrator's policy turns remote debugging off: the cookie is the way in.
      if (error instanceof SyncError && (error.code === 'browser-policy' || error.code === 'browser-no-answer')) {
        output.appendLine(error.message);
        if (await vscode.window.showWarningMessage(error.message, 'Paste session cookie')) await signInWithCookie();
        return;
      }
      // A browser kept running from an earlier attempt (for example after the editor
      // restarted) holds the profile; a new launch only hands it a new window.
      if (!(error instanceof LeftoverSignInWindowError)) throw error;
      output.appendLine(error.message);
      if (error.pid === undefined) throw error;
      const choice = await vscode.window.showWarningMessage(error.message, { detail: 'Turnleaf can quit that browser window and open a new sign-in window.' }, 'Close it and sign in');
      if (!choice) return;
      if (!await closeLeftoverSignInBrowser(profileDir)) throw new SyncError('The earlier sign-in window could not be closed. Quit that browser window yourself and try again.', 'sign-in-window-open');
      progress('Sign in to Overleaf in the browser window. It closes once you are signed in.');
      await attempt();
    }
    await signedIn(s, validated!.client, validated!.projects);
  }
  async function signInWithCookie(cookie?: string): Promise<void> {
    const s = await scope();
    const value = cookie ?? await vscode.window.showInputBox({ title: 'Turnleaf: Sign In with Session Cookie', password: true, ignoreFocusOut: true,
      prompt: `Session cookie value for ${new URL(s.baseUrl).origin}. Stored only in the editor's secret storage.` });
    if (!value) return;
    const client = new OverleafReader(s.baseUrl, value, probe);
    await signedIn(s, client, await client.signIn());
  }
  async function signedIn(s: Scope, client: OverleafReader, projects: Project[]): Promise<void> {
    await context.secrets.store(secretKey(s.baseUrl), client.sessionCookie);
    probe?.signedIn();
    clients.set(s.baseUrl, client);
    workspace.setSessionState('valid');
    status.text = `Overleaf: signed in · ${projects.length} project${projects.length === 1 ? '' : 's'}`;
    output.appendLine(`Sign-in validated using read-only requests; ${projects.length} projects available.`);
  }
  async function inspect(): Promise<Inspection> {
    const s = await scope(), client = await reader(s);
    const result = await client.inspect(s.projectId, s.trackedFiles);
    const config = vscode.workspace.getConfiguration('turnleaf', s.folder.uri);
    if (normalizeBaseUrl(config.get<string>('baseUrl', '')) !== s.baseUrl || config.get('projectId') !== s.projectId || JSON.stringify(validateTrackedFiles(config.get('trackedFiles', []), { allowEmpty: true })) !== JSON.stringify(s.trackedFiles)) {
      throw new SyncError('Overleaf settings changed during the read. Run inspection again.', 'configuration');
    }
    clear();
    latest = result;
    probe?.inspected(result);
    const counts = inspectionCounts(result);
    status.text = `Overleaf: ${counts.open} open · ${counts.suggestions} suggestions · read only`;
    const uri = documents.add('inspection.md', renderInspection(result));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false });
    output.appendLine(`Inspection complete: ${result.docs.length} files, ${counts.open} open threads, ${counts.suggestions} suggestions. No content writes.`);
    return result;
  }
  async function openFile(path?: string): Promise<vscode.Uri | undefined> {
    if (!latest) throw new SyncError('Run Turnleaf: Inspect Project first.', 'configuration');
    const selected = path ?? (await vscode.window.showQuickPick(latest.docs.map(doc => ({ label: doc.path, description: `${doc.otType} · ${doc.comments.length} threads` })), { title: 'Open fetched Overleaf text (read only)' }))?.label;
    const doc = latest.docs.find(doc => doc.path === selected);
    if (!doc) return;
    const existing = openedDocuments.get(doc.path);
    if (existing) {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(existing), { preview: false });
      return existing;
    }
    const uri = documents.add(doc.path, doc.text);
    openedDocuments.set(doc.path, uri);
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    for (const anchor of doc.comments) {
      const remote = latest.threads[anchor.threadId];
      const first = anchor.ranges.find(range => range.length > 0) ?? anchor.ranges[0];
      const start = document.positionAt(first?.pos ?? 0), end = document.positionAt((first?.pos ?? 0) + (first?.length ?? 0));
      const thread = comments.createCommentThread(uri, new vscode.Range(start, end), (remote?.messages ?? []).map(message => ({
        author: { name: message.author }, body: new vscode.MarkdownString().appendText(message.text), mode: vscode.CommentMode.Preview,
        timestamp: message.timestamp !== undefined && Number.isFinite(new Date(message.timestamp).getTime()) ? new Date(message.timestamp) : undefined,
      })));
      thread.canReply = false;
      thread.label = `${remote ? remote.resolved ? 'Resolved' : 'Open' : 'Messages unavailable'} · ${anchorStateLabel(anchor.state)} · Overleaf text`;
      thread.state = remote?.resolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
      threads.push(thread);
    }
    editor.revealRange(new vscode.Range(0, 0, 0, 0));
    return uri;
  }
  // 'quiet': no progress and no lock, for commands that only move the view; 'window': status-bar progress.
  // A command from the project view carries a press tag as its last argument: which press, and where.
  const register = (id: string, action: (...args: any[]) => Promise<unknown>, mode?: CommandMode) => {
    modes.set(id, mode);
    context.subscriptions.push(vscode.commands.registerCommand(id, (...args: any[]) => {
      const tag = pressTag(args.at(-1)); if (tag) args.pop();
      const options = { seq: tag?.seq, surface: tag?.surface };
      return mode === 'quiet' ? runner.quietly(id, () => action(...args), options) : runner.run(id, () => action(...args), { ...options, mode });
    }));
  };
  const workspace = installWorkspace(context, { scope, reader, text: (path, text) => documents.add(path, text), register, output, status,
    isBusy: () => runner.isBusy(), operation: () => runner.operation(), presses,
    background: action => runner.background(action, error => { if (error instanceof SessionExpiredError) { clients.clear(); workspace.setSessionState('expired'); } }),
  });
  register('turnleaf.signIn', () => signIn());
  register('turnleaf.signInWithCookie', () => signInWithCookie());
  register('turnleaf.inspectProject', inspect);
  register('turnleaf.openInspectedFile', () => openFile());
  register('turnleaf.linkProject', async () => {
    const s = await scope();
    const projects = await (await reader(s)).listProjects();
    const choice = await vscode.window.showQuickPick(projects.map(project => ({ label: project.name, description: project.lastUpdated, project })), { title: 'Turnleaf: Link Project' });
    if (!choice) return;
    const settings = vscode.workspace.getConfiguration('turnleaf', s.folder.uri);
    if (choice.project.id !== s.projectId) {
      await settings.update('allowWrites', false, vscode.ConfigurationTarget.WorkspaceFolder);
      // The previous project's files are not this project's: they are chosen again below.
      await settings.update('trackedFiles', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
      await settings.update('projectId', choice.project.id, vscode.ConfigurationTarget.WorkspaceFolder);
    }
    workspace.setSessionState('valid');
    status.text = 'Overleaf: linked · not inspected';
    if (!vscode.workspace.getConfiguration('turnleaf', s.folder.uri).get<string[]>('trackedFiles', []).length) await workspace.chooseFiles();
  });
  register('turnleaf.signOut', async () => {
    const s = await scope();
    await context.secrets.delete(secretKey(s.baseUrl));
    // The sign-in profile holds the same session; remove it with the stored copy.
    await rm(signInProfile(s.baseUrl), { recursive: true, force: true }).catch(error => output.appendLine(`Sign-in profile not removed: ${safeError(error)}`));
    clients.delete(s.baseUrl); workspace.setSessionState('signedOut'); await workspace.disconnect();
  });
  output.appendLine(`Turnleaf ${version} activated. Writes require confirmation. ${vscode.env.appName} ${vscode.version}; Node ${process.versions.node}; window session ${vscode.env.sessionId.slice(0, 8)}, process ${process.pid}.`);
  const sessionStored = async () => Boolean(await context.secrets.get(secretKey((await scope()).baseUrl)));
  const only = vscode.workspace.workspaceFolders?.length === 1 ? vscode.workspace.workspaceFolders[0] : undefined;
  if (context.extensionMode !== vscode.ExtensionMode.Test && only) {
    const linked = () => !!vscode.workspace.getConfiguration('turnleaf', only.uri).get<string>('projectId');
    const chosen = () => vscode.workspace.getConfiguration('turnleaf', only.uri).get<string[]>('trackedFiles', []).length > 0;
    const startup = (async () => {
      if (!linked()) return false;
      if (chosen()) await workspace.restoreCached({ startup: true }).catch(error => output.appendLine(`Cached review unavailable: ${safeError(error)}`));
      return true;
    })();
    ready = startup;
    // The first read right away, not after the check interval; it waits for `ready`.
    void startup.then(isLinked => { if (isLinked) void workspace.checkNow(); });
  }
  if (context.extensionMode !== vscode.ExtensionMode.Test && vscode.workspace.workspaceFolders?.length === 1 && !context.workspaceState.get('turnleaf.overviewIntroduced')) {
    // Only in a folder that holds LaTeX sources; other workspaces keep their sidebar.
    const timer = setTimeout(() => void (async () => {
      if (!(await vscode.workspace.findFiles('**/*.tex', '**/node_modules/**', 1)).length) return;
      await vscode.commands.executeCommand('turnleaf.showOverview'); await context.workspaceState.update('turnleaf.overviewIntroduced', true);
    })().catch(error => output.appendLine(safeError(error))), 500);
    context.subscriptions.push({ dispose() { clearTimeout(timer); runner.abort(); } });
  }
  if (probe) return { sessionStored, projects: async () => (await reader(await scope())).listProjects(), snapshot: () => probe.snapshot() };
  if (context.extensionMode === vscode.ExtensionMode.Test) return {
    signIn, inspect, openFile: async path => (await openFile(path))!, sessionStored, refreshLocal: workspace.refresh, restoreLocal: async (startup?: boolean) => { workspace.clear(); await workspace.restoreCached({ startup }); if (startup) await workspace.checkNow(); }, reviewSnapshot: workspace.snapshot, reviewThread: workspace.threadForTest, reviewCommentingRanges: workspace.commentingRangesForTest, reviewView: workspace.viewForTest, reviewRenders: workspace.rendersForTest, summarySettled: workspace.summarySettledForTest,
    summaryChangedAt: workspace.summaryChangedAtForTest, answerConfirmation: workspace.answerConfirmationForTest, viewMessage: workspace.viewMessageForTest, outputLines: () => [...outputLines], actionsWritten: () => log.flushed(),
    runtime: () => ({ node: process.versions.node, editor: vscode.version, app: vscode.env.appName }),
  };
  return undefined;
}
