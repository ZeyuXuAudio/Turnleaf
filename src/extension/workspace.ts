import * as vscode from 'vscode';
import { writeFile, readFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Cache, Reviews, workspacePath } from '../core/storage';
import { OverleafReader, RemoteSession } from '../core/overleaf';
import { classifyLiveEvent } from '../core/live';
import { SyncService, pushReport, PushPlan, ReviewWorkflow, PullPlan, SendBlock, UndoPlan, planDifferences, irreversible, sameRemote, sameContent, projectedInspection, fingerprint, pullChanges } from '../core/folderWorkflow';
import { OutgoingPicture, gitBlobSha1, isPicture, outgoingSummary, pictureConflict, pictureSummary, picturesIncoming, remotePictures, samePictures, sendsPicture } from '../core/pictures';
import { ProjectStore, ProjectData, CommentDraft, CommentChange, isDecision, carrySelection } from '../core/projectStore';
import { SuggestionAuthor, sameSuggestion, suggestionAuthors, suggestionRef, suggestionsInRange } from '../core/suggestions';
import { readSaved, sameSaved, SavedTexts } from '../core/savedFiles';
import { RemotePoller } from '../core/polling';
import { DocState, Inspection, Suggestion } from '../core/models';
import { ReviewRow, anchorLabel, reviewRows, trackedInspection, renderReviewLog, localStatus, rememberAnchors, textGone } from '../core/review';
import { Mapping } from '../core/ranges';
import { Diff, composeEdits } from '../core/diff';
import { SessionExpiredError, SyncError, safeError } from '../core/errors';
import { ActionResult, ActionTarget, Cause, Press, PressTracker, Refusal, SEND_COMMANDS, SETTLE_MS, causeText, pressNotice, sendGate, writesStarted } from '../core/actionLog';
import { annotatePdf } from '../core/pdf';
import { ReviewComputer } from './reviewComputer';
import { projectPanel, projectContent, ProjectView, OutgoingView, UndoView, Surface, SuggestionRow, ThreadDetail, Place, ReviewFilter, reviewFilterDefault, matchesThreadFilter, matchesSuggestionFilter } from './panel';
import { validateTrackedFiles } from '../core/docState';
import { ReviewDiffDecorations } from './diffDecorations';
import { markerStyle } from './markerStyle';
import { historyPage, threadText } from './history';
import { shortDateTime } from './format';
import { DeletionDisplay, deletionDisplay, deletionDisplays, deletionPreview, drawnDeletionDisplay, struckThrough } from './deletionDisplay';
import { LocalReviewFiles } from '../core/reviewFiles';
import { FRESHNESS, LOCAL_APPLIED, REVIEW_FILES_IMPORTED, SENT_VERIFIED, UNDO_SENT_VERIFIED, commentNote, diffSides, diffTabTitle, diffTitle, stateLabel as syncStateLabel, statusText } from './syncText';

export interface WorkspaceScope { folder: vscode.WorkspaceFolder; baseUrl: string; projectId: string; trackedFiles: string[]; }
/** 'quiet': no progress and no operation lock, for commands that only move the view. 'window': status-bar progress. */
export type CommandMode = 'quiet' | 'window';
interface Host {
  scope(): Promise<WorkspaceScope>; reader(scope: WorkspaceScope): Promise<OverleafReader>;
  text(path: string, text: string): vscode.Uri;
  register(id: string, action: (...args: any[]) => Promise<unknown>, mode?: CommandMode): void;
  output: vscode.OutputChannel; status: vscode.StatusBarItem;
  isBusy(): boolean;
  /** What holds the operation lock, in words ("Get latest", "background check"). */
  operation(): string | undefined;
  background(action: () => Promise<void>): Promise<boolean>;
  /** The press record: each press on a view button, and its outcome when it ends without a command. */
  presses: { pressed(press: Press): void; ended(press: Press, result: ActionResult): void };
}
// Arguments of a command link in trusted Markdown. encodeURIComponent leaves ( and ) as they are,
// and an unmatched ) in a file name or ID would end the link early.
const commandArgs = (value: unknown) => encodeURIComponent(JSON.stringify(value)).replace(/\(/g, '%28').replace(/\)/g, '%29');
interface RemoteComment extends vscode.Comment { threadId: string; messageId?: string; original: string; }
// The Get latest preview. Sending has no prepared review: its summary is the standing plan below.
type PreparedReview = { id: string; kind: 'pull'; source: SyncService; created: number; stale?: string; complete?: string; plan: PullPlan };
// A summary as shown: `changedAt` is when its content last changed (a click sooner than 650 ms
// after that does not send) and `cause` what changed it, `changed` the rows that differed at
// the last click, with `notice`.
interface Shown { changedAt: number; cause?: Cause; changed?: string[]; notice?: string; blocked?: SendBlock; }
interface StandingSend extends Shown { plan?: PushPlan; marks?: Record<string, string>; }
interface StandingUndo extends Shown { record: string; time: string; plan?: UndoPlan; }
export function installWorkspace(context: vscode.ExtensionContext, host: Host) {
  const controller = vscode.comments.createCommentController('turnleaf-local', 'Overleaf');
  const highlight = vscode.window.createTextEditorDecorationType({ backgroundColor: new vscode.ThemeColor('turnleaf.commentBackground'), borderColor: new vscode.ThemeColor('turnleaf.commentBorder'), borderStyle: 'solid', borderWidth: '0 0 1px 0', overviewRulerColor: new vscode.ThemeColor('editorInfo.foreground'), overviewRulerLane: vscode.OverviewRulerLane.Right, rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed });
  const insertion = vscode.window.createTextEditorDecorationType({ backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'), overviewRulerColor: new vscode.ThemeColor('gitDecoration.addedResourceForeground') });
  const marker = vscode.window.createTextEditorDecorationType({});
  // `marker` deletion display: the character at the deletion point gets a bar on the side
  // that faces the deletion. A box shadow takes no room, so word wrap is unchanged.
  const pointMark = (side: 'left' | 'right') => vscode.window.createTextEditorDecorationType({ backgroundColor: new vscode.ThemeColor('turnleaf.removedTextBackground'), textDecoration: `none; box-shadow: inset ${side === 'left' ? '' : '-'}2px 0 0 var(--vscode-turnleaf-removedForeground)`, overviewRulerColor: new vscode.ThemeColor('turnleaf.removedForeground'), overviewRulerLane: vscode.OverviewRulerLane.Right });
  const deletionAfter = pointMark('left'), deletionBefore = pointMark('right');
  // `inlayHint` deletion display: the hints the provider returns, per document, from the last draw.
  const deletionHints = new Map<string, vscode.InlayHint[]>(), deletionHintsChanged = new vscode.EventEmitter<void>();
  const previewColors = new ReviewDiffDecorations();
  const markers = markerStyle(context);
  const ids = new WeakMap<vscode.CommentThread, string>();
  const threadViews = new WeakMap<vscode.CommentThread, { row: ReviewRow; status: string; documentVersion: number; marker: string }>();
  // A disposed thread ignores updates, so a draw must never reuse one.
  const disposedThreads = new WeakSet<vscode.CommentThread>();
  const dropThread = (thread: vscode.CommentThread) => { disposedThreads.add(thread); thread.dispose(); };
  const computer = new ReviewComputer(context.asAbsolutePath('dist/review-worker.js'));
  const computed = new Map<string, { inspection: Inspection; text: string; mapping: Mapping; rows: ReviewRow[] }>();
  const diskTexts = new Map<string, string>();
  let service: SyncService | undefined, inspection: Inspection | undefined, cache: Cache = { schema: 1, anchors: {} }, reviews: Reviews = {}, rows: ReviewRow[] = [], author: string | undefined;
  let projectData: ProjectData = { schema: 2, anchors: {}, reviews: {}, pending: [] };
  let reviewFilesError = '', reviewFilesTimer: NodeJS.Timeout | undefined;
  let threads: vscode.CommentThread[] = [], panel: vscode.WebviewPanel | undefined, debounce: NodeJS.Timeout | undefined, pendingDraw: Promise<void> | undefined, drawAgain = false;
  let commentingRangeKey = '';
  // The one comment without a marker that has been opened, so it has its thread.
  let revealedThread: string | undefined;
  const commentingRanges = (document: vscode.TextDocument): vscode.Range[] => [...new Set(threads
    .filter(thread => thread.uri.toString() === document.uri.toString())
    .map(thread => thread.range.end.line))].sort((a, b) => a - b)
    .map(line => new vscode.Range(line, 0, line, 0));
  function updateCommentingRanges() {
    // Cursor gates native gutter clicks on the presence of commenting ranges,
    // even for existing threads. Expose only their glyph lines: creation on a
    // new selection remains the explicit New Comment on Selection command.
    const key = JSON.stringify(threads.map(thread => [thread.uri.toString(), thread.range.end.line]).sort());
    if (key === commentingRangeKey) return;
    commentingRangeKey = key;
    controller.commentingRangeProvider = { provideCommentingRanges: commentingRanges };
  }
  const diffs = new Map<string, { local: string; diffs: Diff[] }>();
  let lastSource: vscode.TextEditor | undefined, cached = true, needsPull = true, note = '', session: 'unknown' | 'valid' | 'expired' | 'signedOut' = 'unknown';
  let statusVersion = 0, configurationVersion = 0;
  let overview: vscode.WebviewView | undefined, prepared: PreparedReview | undefined, allComments = false, applying = false, sending = false;
  let checkedAt: string | undefined, freshness: string = FRESHNESS.unchecked, disposed = false;
  // True from a changed file selection until the first read of the new selection ends:
  // the review was rebuilt from the cache, but the sign-in and the sync state still hold.
  // `reselecting` is set while Choose source files writes the new selection, so the
  // reset that the settings change causes keeps the sign-in and starts `checking`.
  let checking = false, reselecting = false;
  let selectedThread: string | undefined, selectedDiff: string | undefined, highlightComments = context.workspaceState.get<boolean>('turnleaf.highlightComments', true);
  let decorated = { comments: 0, insertions: 0, deletions: 0 };
  const resolutionPaths = new Map<string, vscode.Uri>(), conflictNotes = new Map<string, string>();
  // Suggestions, positioned in the local text by the last draw.
  let suggestionRows: SuggestionRow[] = [];
  // The standing outgoing summary: what Send would write, from the saved files, the queued
  // comment changes and the last observed Overleaf state. Recomputed locally, never by a request.
  let standing: StandingSend | undefined, undoing: StandingUndo | undefined, standingBusy = false, standingTimer: NodeJS.Timeout | undefined, standingRun = 0;
  // New comments whose selected text changed since it was selected: they need Update selection.
  let unplacedDrafts = new Set<string>();
  let standingInputs: { key: string; saved: SavedTexts } | undefined;
  // What the next summary refresh is for, and what the running one is for: shown as "Updating: …".
  let pendingCause: Cause | undefined, pendingMarked = false, refreshCause: Cause | undefined;
  // Why the last press on Send or Send undo did not send; until the next press or summary change.
  let pressNote: string | undefined, settleTimer: NodeJS.Timeout | undefined;
  // The latest live event that re-reads Overleaf: the cause of the summary refresh it brings.
  let liveCause: Cause | undefined;
  // The Send in flight, so events that made a review out of date also stop it.
  let activeSend: { saved: SavedTexts; stale?: string } | undefined;
  // The latest verified Send while the status still reports it (offers Undo), and its result report.
  let lastSent: { id: string; note: string } | undefined, lastReport: string | undefined, noteHold = false;
  const config = () => vscode.workspace.getConfiguration('turnleaf', service ? vscode.Uri.file(service.root) : undefined);
  const linkedWithoutFiles = () => !!config().get<string>('projectId') && !config().get<string[]>('trackedFiles', []).length;
  // One linked folder with chosen files: its cached review can be shown.
  const restorable = () => vscode.workspace.workspaceFolders?.length === 1 && !!config().get<string>('projectId') && !linkedWithoutFiles();
  const writes = () => config().get<boolean>('allowWrites', false);
  const reviewFilesOn = () => config().get<boolean>('localReviewFiles', true);
  let reviewFilter: ReviewFilter = { ...reviewFilterDefault, ...context.workspaceState.get<Partial<ReviewFilter>>('turnleaf.reviewFilter') };
  // While the window is in the background, a paused live connection is not
  // replaced by polling; checks resume when the window regains focus.
  const poller = new RemotePoller(() => paused ? Promise.resolve(true) : host.background(checkRemote), error => {
    freshness = 'Remote state unknown · retry delayed'; host.output.appendLine(`Remote check: ${safeError(error)}`); paintStatus();
  });
  const liveEnabled = () => config().get<boolean>('liveUpdates', true);
  const automaticChecks = () => liveEnabled() || [10, 30, 60].includes(config().get<number>('remoteCheckInterval', 10));
  let live: { key: string; session: RemoteSession; off(): void } | undefined, connecting: Promise<RemoteSession | undefined> | undefined;
  let paused = false, reconnectLive = false, idleTimer: NodeJS.Timeout | undefined, liveTimer: NodeJS.Timeout | undefined;
  // One realtime connection per linked project, reused by checks and Send.
  const liveAllowed = () => liveEnabled() && !paused && !disposed && session !== 'expired' && session !== 'signedOut';
  function connectLive(scope: WorkspaceScope): Promise<RemoteSession | undefined> {
    if (!liveAllowed()) return Promise.resolve(undefined);
    const key = JSON.stringify([scope.baseUrl, scope.projectId, scope.trackedFiles]);
    if (live?.key === key && live.session.socket.alive) return Promise.resolve(live.session);
    return connecting ??= (async () => {
      closeLive();
      const opened = await (await host.reader(scope)).openSession(scope.projectId, scope.trackedFiles, { live: true });
      // Signed out, disabled or disposed while connecting: do not keep it.
      if (!liveAllowed()) { await opened.close(); return undefined; }
      const offEvent = opened.socket.onEvent(name => {
        const kind = classifyLiveEvent(name);
        // Every event: a summary refresh names the one that started it.
        host.output.appendLine(`Live event: ${name} (${kind === 'ignore' ? 'ignored' : kind === 'reconnect' ? 'reconnects' : 're-reads changed files and comments'})`);
        if (kind !== 'ignore') { liveCause = { label: 'Overleaf changed', detail: `live event ${name}`, at: Date.now() }; scheduleLiveUpdate(kind === 'reconnect'); }
      });
      const offClose = opened.socket.onClose(error => {
        if (live?.session !== opened) return;
        live = undefined; freshness = 'Connection lost · reconnecting'; host.output.appendLine(`Live connection: ${safeError(error)}`); paintStatus(); poller.soon(2000);
      });
      live = { key, session: opened, off() { offEvent(); offClose(); } };
      return opened;
    })().finally(() => { connecting = undefined; });
  }
  // `closing` is the latest close in flight, so Sign out can wait for it.
  let closing: Promise<void> = Promise.resolve();
  function closeLive(): Promise<void> {
    const current = live; live = undefined;
    if (!current) return closing;
    current.off(); closing = current.session.close().catch(() => {}); return closing;
  }
  function scheduleLiveUpdate(reconnect = false, delay = 400) {
    if (reconnect) reconnectLive = true;
    // Tests drive checks explicitly; events alone must not race their steps.
    if (context.extensionMode === vscode.ExtensionMode.Test || disposed) return;
    if (liveTimer) clearTimeout(liveTimer);
    liveTimer = setTimeout(() => {
      liveTimer = undefined;
      void host.background(liveUpdate).then(ran => { if (!ran) scheduleLiveUpdate(false, 2000); }).catch(error => host.output.appendLine(`Live update: ${safeError(error)}`));
    }, delay);
  }
  async function liveUpdate() {
    if (reconnectLive) { reconnectLive = false; closeLive(); }
    // Comments plus only the documents edited since the last read.
    const cause = liveCause ?? { label: 'Overleaf changed', detail: 'live update', at: Date.now() }; liveCause = undefined;
    const s = await setup(), fresh = await s.fetchPull({ docs: 'changed' });
    if (service === s) await observe(s, fresh, cause);
  }
  async function setup(): Promise<SyncService> {
    if (service) return service;
    const version = configurationVersion;
    const scope = await host.scope();
    if (!scope.projectId) throw new SyncError('Link an Overleaf project first.', 'configuration');
    if (!scope.trackedFiles.length) throw new SyncError('Choose the source files to synchronize first.', 'configuration');
    await markers.ensureForLinkedWorkspace().catch(error => host.output.appendLine(`Editor marker appearance: ${safeError(error)}`));
    const state = new ProjectStore(scope.folder.uri.fsPath, scope.baseUrl, scope.projectId, scope.trackedFiles);
    state.retention = () => ({ records: Math.max(0, config().get<number>('historyLimit', 50)), days: Math.max(0, config().get<number>('historyDays', 90)) });
    state.syncPictures = () => config().get<boolean>('syncPictures', true);
    await state.init();
    const stored = await state.cache(), decisions = await state.reviews();
    if (version !== configurationVersion) throw new SyncError('Workspace settings changed. Run the command again.', 'configuration');
    service = new SyncService(state, () => host.reader(scope), () => connectLive(scope));
    service.sendCheck = () => config().get<string>('sendCheck', 'full') === 'fast' ? 'fast' : 'full';
    projectData = await state.read();
    cache = stored; reviews = decisions;
    scheduleCheck(); if (liveEnabled()) poller.soon(1000);
    return service;
  }
  function clear() {
    const keep = reselecting && session === 'valid';
    reviewFilesError = ''; clearTimeout(reviewFilesTimer); reviewFilesTimer = undefined;
    inspection = undefined; service = undefined; rows = []; diffs.clear(); computed.clear(); diskTexts.clear(); computer.dispose(); lastSource = undefined; cached = true; needsPull = true; note = ''; statusVersion++; checking = keep;
    cache = { schema: 1, anchors: {} }; reviews = {}; author = undefined; session = keep ? 'valid' : 'unknown'; configurationVersion++;
    projectData = { schema: 2, anchors: {}, reviews: {}, pending: [] };
    threads.splice(0).forEach(dropThread); updateCommentingRanges(); prepared = undefined; resolutionPaths.clear(); closeLive();
    selectedThread = undefined; selectedDiff = undefined; revealedThread = undefined; decorated = { comments: 0, insertions: 0, deletions: 0 }; previewColors.clear(); deletionHints.clear(); deletionHintsChanged.fire();
    standing = undefined; undoing = undefined; standingInputs = undefined; standingRun++; standingBusy = false; clearTimeout(standingTimer); standingTimer = undefined; lastSent = undefined; lastReport = undefined;
    pendingCause = undefined; pendingMarked = false; refreshCause = undefined; pressNote = undefined; clearTimeout(settleTimer); settleTimer = undefined;
    poller.configure(0);
    checkedAt = undefined; freshness = FRESHNESS.unchecked; renderPanel();
    if (debounce) clearTimeout(debounce);
    for (const e of vscode.window.visibleTextEditors) for (const type of [highlight, insertion, marker, deletionAfter, deletionBefore]) e.setDecorations(type, []);
  }
  async function texts(): Promise<Record<string, string>> {
    const s = service!, values: Record<string, string> = {};
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme !== 'file') continue;
      const path = relative(service!.root, doc.uri.fsPath).replace(/\\/g, '/');
      if (service!.paths.includes(path)) values[path] = doc.getText();
    }
    for (const path of s.paths) if (!(path in values)) {
      if (!diskTexts.has(path)) {
        try { diskTexts.set(path, await readFile(await workspacePath(s.root, path), 'utf8')); }
        catch (error: any) { if (error.code !== 'ENOENT') throw error; }
      }
      if (diskTexts.has(path)) values[path] = diskTexts.get(path)!;
    }
    return values;
  }
  const outgoingRows = () => (standing?.plan?.files.length ?? 0) + (standing?.plan?.comments.length ?? 0);
  function stateLabel(): string {
    const files = standing?.plan?.files.length ?? 0, comments = standing?.plan?.comments.length ?? 0;
    return syncStateLabel({ reviewFilesError, localApply: !!cache.localApply, partialPush: !!cache.partialPush, session, checking, cached, inspected: !!inspection, serviceReady: !!service, linkedWithoutFiles: linkedWithoutFiles(), needsPull, note,
      preview: prepared && { stale: prepared.stale, complete: prepared.complete, conflicts: prepared.plan.files.some(f => f.conflict) || !!prepared.plan.pictures?.some(pictureConflict), kept: prepared.plan.files.some(kept) },
      undo: undoing && { notice: undoing.notice, blocked: !!undoing.blocked },
      standing: standing && { notice: standing.notice, files, comments, incoming: !!standing.plan?.incoming, blocked: !!standing.blocked } });
  }
  function paintStatus() {
    const open = rows.filter(r => !r.thread.resolved).length, suggestions = inspection?.docs.reduce((n, d) => n + d.changes.length, 0) ?? 0;
    const unsent = standing?.plan ? outgoingRows() : projectData.pending.length;
    host.status.text = statusText({ session, localApply: !!cache.localApply, preview: prepared && { stale: prepared.stale, complete: prepared.complete }, partialPush: !!cache.partialPush, reconciliation: !!cache.reconciliation, checking, cached, inspected: !!inspection, freshness, needsPull, note, open, suggestions, unsent });
    host.status.tooltip = `Turnleaf ${context.extension.packageJSON.version}\n${stateLabel()}\n${freshness}${checkedAt ? ' · ' + new Date(checkedAt).toLocaleTimeString() : ''}`; host.status.command = 'turnleaf.showOverview';
    renderPanel();
  }
  // `cause`: what may have changed the summary inputs, for the summary refresh this schedules.
  async function status(message?: string, cause?: Cause) {
    if (!inspection || !service) return;
    const s = service, i = inspection, version = ++statusVersion;
    const data = await s.state.read(), stored = await s.state.cache();
    const warning = !data.acknowledged || !!data.observed && (!sameContent(data.acknowledged, data.observed) || s.state.syncPictures() && picturesIncoming(data.observed, await s.state.pictures()));
    if (s !== service || i !== inspection || version !== statusVersion) return;
    needsPull = warning; if (message !== undefined) note = message;
    projectData = data; cache = stored; paintStatus(); scheduleStanding(false, cause);
  }
  // Author and date, then only the exceptions, as on the cards.
  function hover(row: ReviewRow): vscode.MarkdownString {
    const m = row.thread.messages[0], md = new vscode.MarkdownString(), local = localStatus(row.thread.id, reviews), replies = row.thread.messages.length - 1;
    const notes = [projectData.pending.some(draft => draft.threadId === row.thread.id) && 'Pending send', row.thread.resolved && 'Resolved', row.anchor.label !== 'unchanged' && anchorLabel(row.anchor.label), local !== 'open locally' && local].filter(Boolean);
    md.appendMarkdown('**').appendText(m?.author ?? 'Unknown author').appendMarkdown('**').appendText([shortDateTime(m?.timestamp), ...notes].filter(Boolean).map(text => ` · ${text}`).join(''));
    md.appendMarkdown('\n\n').appendText(m?.text ?? '');
    if (replies) md.appendMarkdown('\n\n').appendText(replies === 1 ? '1 reply' : `${replies} replies`);
    const link = (label: string, command: string) => `[${label}](command:turnleaf.${command}?${commandArgs([row.thread.id])})`;
    md.appendMarkdown(`\n\n${link('Open thread', 'openThread')} · ${link('Reply', 'reply')} · ${row.thread.resolved ? link('Reopen on send', 'reopen') : link('Resolve on send', 'resolve')}`);
    md.isTrusted = { enabledCommands: ['turnleaf.openThread', 'turnleaf.reply', 'turnleaf.resolve', 'turnleaf.reopen'] }; return md;
  }
  function draw(): Promise<void> {
    if (pendingDraw) { drawAgain = true; return pendingDraw; }
    pendingDraw = (async () => {
      do { drawAgain = false; await drawOnce(); } while (drawAgain);
    })().finally(() => { pendingDraw = undefined; });
    return pendingDraw;
  }
  async function drawOnce(): Promise<void> {
    if (!inspection || !service) return;
    const s = service, i = inspection;
    try {
      const values = await texts();
      if (s !== service || i !== inspection) return;
      const mappings = new Map<string, Mapping>();
      const nextRows: ReviewRow[] = [];
      for (const doc of trackedInspection(i, cache).docs) {
        const local = values[doc.path] ?? doc.text;
        let result = computed.get(doc.path);
        if (!result || result.inspection !== i || result.text !== local) {
          const diff = diffs.get(doc.path);
          const calculation = await computer.compute({ doc, local, trackChanges: i.trackChanges, diffs: diff?.local === local ? diff.diffs : undefined });
          if (s !== service || i !== inspection) return;
          const buffer = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && d.uri.fsPath === vscode.Uri.joinPath(vscode.Uri.file(s.root), doc.path).fsPath);
          if (buffer && buffer.getText() !== local) { drawAgain = true; return; }
          diffs.set(doc.path, { local, diffs: calculation.diffs });
          result = { inspection: i, text: local, mapping: calculation.mapping, rows: reviewRows({ ...i, docs: [doc] }, cache, { [doc.path]: local }, new Map([[doc.path, calculation.mapping]])) };
          computed.set(doc.path, result);
        }
        mappings.set(doc.path, result.mapping); nextRows.push(...result.rows);
      }
      // New threads are anchored in the saved local selection, which may lie
      // inside an insertion absent from the accepted remote document.
      for (const draft of projectData.pending.filter(draft => draft.kind === 'createThread' && draft.anchor)) {
        const source = i.docs.find(doc => doc.path === draft.path); if (!source) continue;
        const range = { pos: draft.anchor!.from, length: draft.anchor!.to - draft.anchor!.from };
        const doc = { ...source, text: draft.anchor!.source, rawContent: draft.anchor!.source, rawChanges: [], changes: [], comments: [{ threadId: draft.threadId, ranges: [range], state: 'placed' as const }] };
        const replacement = reviewRows({ ...i, docs: [doc] }, { schema: 1, anchors: {} }, values);
        const index = nextRows.findIndex(row => row.thread.id === draft.threadId); if (index >= 0) nextRows.splice(index, 1);
        nextRows.push(...replacement);
      }
      const nextSuggestions: SuggestionRow[] = [];
      for (const [path, mapping] of mappings) {
        const local = values[path] ?? '';
        for (const c of mapping.changes) {
          const decided = projectData.pending.find(draft => isDecision(draft) && draft.path === path && sameSuggestion(draft.change!, c));
          nextSuggestions.push({ id: c.id, path, line: local.slice(0, c.pos).split('\n').length, pos: c.pos, kind: c.kind, text: c.text, author: c.author, ...c.authorId !== undefined && { authorId: c.authorId }, timestamp: c.timestamp, ...decided && { decision: decided.kind === 'acceptChange' ? 'accept' : 'reject' } });
        }
      }
      suggestionRows = nextSuggestions;
      rows = nextRows.sort((a, b) => Number(!a.line) - Number(!b.line) || a.path.localeCompare(b.path) || a.line - b.line || a.thread.id.localeCompare(b.thread.id));
      const pendingThreads = new Set(projectData.pending.map(draft => draft.threadId).filter(Boolean));
      const threadVisible = (row: ReviewRow) => (!author || row.thread.messages.some(m => m.author === author))
        && (matchesThreadFilter(row.thread.resolved, pendingThreads.has(row.thread.id), reviewFilter) || revealedThread === row.thread.id);
      const previousThreads = new Map(threads.filter(t => !disposedThreads.has(t)).map(t => [ids.get(t)!, t]));
      const nextThreads: vscode.CommentThread[] = [];
      const documents = new Map(vscode.workspace.textDocuments.map(doc => [doc.uri.toString(), doc]));
      for (const row of rows.filter(threadVisible)) {
        const existing = previousThreads.get(row.thread.id), local = localStatus(row.thread.id, reviews), priorView = existing && threadViews.get(existing);
        const uri = vscode.Uri.joinPath(vscode.Uri.file(s.root), row.path);
        let doc: vscode.TextDocument;
        // An unreadable file keeps its thread in previousThreads, removed below.
        try { doc = documents.get(uri.toString()) ?? await vscode.workspace.openTextDocument(uri); documents.set(uri.toString(), doc); } catch { continue; }
        // No marker: the highlight stands for the comment until it is opened.
        const range = markerRange(row, doc); if (!range) continue;
        const marker = `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
        previousThreads.delete(row.thread.id);
        if (existing) existing.canReply = true;
        if (existing && priorView?.row === row && priorView.status === local && priorView.documentVersion === doc.version && priorView.marker === marker) { nextThreads.push(existing); continue; }
        // Superseded while opening a file: `threads` still shows the reused
        // threads, so remove only the ones this draw created.
        if (s !== service || i !== inspection) { nextThreads.filter(t => !threads.includes(t)).forEach(dropThread); return; }
        const thread = existing ?? controller.createCommentThread(uri, range, []);
        // The workbench moves native glyphs during edits without updating the
        // extension-host range. A whole-buffer replacement can collapse a glyph
        // to line 1 even when its recomputed range is unchanged. Force the final
        // range through the API's equality check, preserving the thread/drafts.
        if (existing && priorView?.documentVersion !== doc.version && thread.range.isEqual(range)) {
          thread.range = new vscode.Range(range.start, range.end.translate(0, 1));
        }
        thread.range = range;
        if (priorView?.row.thread !== row.thread) {
          const previous = thread.comments as readonly RemoteComment[];
          thread.comments = row.thread.messages.map(m => {
            const old = previous.find(c => c.messageId && c.messageId === m.id);
            if (old?.mode === vscode.CommentMode.Editing) return old;
            const editable = m.id && m.authorId && m.authorId === i.userId;
            return { threadId: row.thread.id, messageId: m.id, original: m.text, author: { name: m.author }, ...m.id?.startsWith('draft:') && { label: 'Pending send' }, body: m.text, mode: vscode.CommentMode.Preview, contextValue: editable ? 'overleaf.ownMessage' : 'overleaf.message', timestamp: m.timestamp !== undefined && Number.isFinite(new Date(m.timestamp).getTime()) ? new Date(m.timestamp) : undefined } satisfies RemoteComment;
          });
        }
        // Only exceptions: an open, unchanged thread needs no label.
        thread.label = [projectData.pending.some(draft => draft.threadId === row.thread.id) && 'Pending send', row.thread.resolved && 'Resolved', row.anchor.label !== 'unchanged' && anchorLabel(row.anchor.label), local !== 'open locally' && local].filter(Boolean).join(' · ') || undefined;
        thread.state = row.thread.resolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
        // Menus offer only the local review moves that apply.
        thread.contextValue = `${row.thread.resolved ? 'overleaf.resolved' : 'overleaf.open'}.${local === 'open locally' ? 'local-open' : local.startsWith('addressed') ? 'local-addressed' : 'local-declined'}`;
        thread.canReply = true; if (!existing) thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
        ids.set(thread, row.thread.id); nextThreads.push(thread);
        threadViews.set(thread, { row, status: local, documentVersion: doc.version, marker });
      }
      previousThreads.forEach(dropThread); threads = nextThreads; updateCommentingRanges();
      const nextDecorated = { comments: 0, insertions: 0, deletions: 0 };
      deletionHints.clear();
      for (const editor of vscode.window.visibleTextEditors) {
        const path = relative(s.root, editor.document.uri.fsPath).replace(/\\/g, '/'), map = mappings.get(path);
        const selected = rows.filter(r => r.path === path && threadVisible(r));
        const options: vscode.DecorationOptions[] = [], markers: vscode.DecorationOptions[] = [], afterPoint: vscode.DecorationOptions[] = [], beforePoint: vscode.DecorationOptions[] = [], hints: vscode.InlayHint[] = [];
        const display = drawnDeletionDisplay(deletionDisplaySetting(), vscode.workspace.getConfiguration('editor', editor.document).get('inlayHints.enabled'));
        for (const row of selected) {
          if (!highlightComments) continue;
          for (const r of row.anchor.ranges.filter(r => r.length > 0)) options.push({ range: new vscode.Range(editor.document.positionAt(r.pos), editor.document.positionAt(r.pos + r.length)), hoverMessage: hover(row) });
        }
        const inserts: vscode.DecorationOptions[] = [];
        if (highlightComments) for (const c of map?.changes ?? []) {
          // Decisions wait for Send, like resolving a comment.
          const decided = suggestionRows.find(row => row.path === path && row.id === c.id)?.decision;
          if (!matchesSuggestionFilter(!!decided, reviewFilter)) continue;
          const point = editor.document.positionAt(c.pos), md = new vscode.MarkdownString().appendMarkdown(`**${c.kind === 'insert' ? 'Suggested insertion' : 'Suggested deletion'}**`).appendText([c.author, shortDateTime(c.timestamp)].filter(Boolean).map(text => ` · ${text}`).join('')).appendMarkdown('\n\n').appendText(c.text).appendMarkdown('\n\n');
          const args = commandArgs([{ path, value: c.id }]);
          md.appendMarkdown(`${decided ? `*${decided === 'accept' ? 'Accept' : 'Reject'} on send* · ` : ''}[$(check) ${decided === 'accept' ? 'Undo accept' : 'Accept'}](command:turnleaf.acceptChange?${args}) · [$(close) ${decided === 'reject' ? 'Undo reject' : 'Reject'}](command:turnleaf.rejectChange?${args})`);
          md.supportThemeIcons = true; md.isTrusted = { enabledCommands: ['turnleaf.acceptChange', 'turnleaf.rejectChange'] };
          if (c.kind === 'insert') inserts.push({ range: new vscode.Range(point, editor.document.positionAt(c.pos + c.text.length)), hoverMessage: md });
          else if (display === 'inlayHint') {
            const hint = new vscode.InlayHint(point, struckThrough(deletionPreview(c.text)));
            hint.tooltip = md; hints.push(hint);
          } else if (display === 'marker') {
            // The character after the deletion point; at a line end, the one before it.
            const line = editor.document.lineAt(point.line).text;
            if (point.character < line.length) afterPoint.push({ range: new vscode.Range(point, point.translate(0, 1)), hoverMessage: md });
            else if (point.character > 0) beforePoint.push({ range: new vscode.Range(point.translate(0, -1), point), hoverMessage: md });
            // An empty line never wraps, so a thin bar there costs no room that matters.
            else markers.push({ range: new vscode.Range(point, point), hoverMessage: md, renderOptions: { before: { contentText: '\u200b', width: '2px', backgroundColor: new vscode.ThemeColor('turnleaf.removedForeground') } } });
          }
          // Like Overleaf: the suggested deletion stays readable, struck through.
          else markers.push({ range: new vscode.Range(point, point), hoverMessage: md, renderOptions: { before: { contentText: deletionPreview(c.text), textDecoration: 'line-through', color: new vscode.ThemeColor('turnleaf.removedForeground'), backgroundColor: new vscode.ThemeColor('turnleaf.removedTextBackground') } } });
        }
        nextDecorated.comments += options.length; nextDecorated.insertions += inserts.length; nextDecorated.deletions += markers.length + afterPoint.length + beforePoint.length + hints.length;
        editor.setDecorations(highlight, options); editor.setDecorations(insertion, inserts); editor.setDecorations(marker, markers);
        editor.setDecorations(deletionAfter, afterPoint); editor.setDecorations(deletionBefore, beforePoint);
        if (hints.length) deletionHints.set(editor.document.uri.toString(), hints);
      }
      decorated = nextDecorated; deletionHintsChanged.fire();
      followEditor(vscode.window.activeTextEditor); paintStatus();
    } catch (error) { if (s === service && i === inspection) throw error; }
  }
  function rowRange(row: ReviewRow, doc: vscode.TextDocument): vscode.Range {
    if (!row.line || row.anchor.label === 'anchor removed') { const p = new vscode.Position(Math.min(doc.lineCount - 1, Math.max(0, row.line - 1)), 0); return new vscode.Range(p, p); }
    const r = row.anchor.ranges.find(r => r.length) ?? row.anchor.ranges[0];
    return new vscode.Range(doc.positionAt(r?.pos ?? 0), doc.positionAt((r?.pos ?? 0) + (r?.length ?? 0)));
  }
  // Cursor draws a thread's marker on every wrapped row of the line where its range ends.
  // Below the paragraph: the range ends on the blank line after the commented line. When
  // there is none, the comment has no marker until opened; its highlight shows it.
  const deletionDisplaySetting = () => deletionDisplay(config().get('deletionDisplay'));
  const markersBelow = (doc: vscode.TextDocument) => config().get<string>('commentMarkers', 'belowParagraph') === 'belowParagraph' && vscode.workspace.getConfiguration('editor', doc).get<string>('wordWrap', 'off') !== 'off';
  function markerRange(row: ReviewRow, doc: vscode.TextDocument): vscode.Range | undefined {
    const range = rowRange(row, doc);
    if (!markersBelow(doc) || !row.line || textGone(row.anchor.label)) return range;
    const next = range.end.line + 1;
    if (next < doc.lineCount && !doc.lineAt(next).text.trim()) return new vscode.Range(range.start, new vscode.Position(next, 0));
    // No blank line: the highlight stands for the comment, so without one the marker stays.
    return revealedThread === row.thread.id || !highlightComments || !row.anchor.ranges.some(r => r.length > 0) ? range : undefined;
  }
  async function refresh() {
    const s = await setup(), fresh = await s.refresh(), stored = await s.state.cache();
    if (service !== s) throw new SyncError('Workspace settings changed during refresh. Run Refresh again.', 'configuration');
    if (prepared && !prepared.complete && (!sameRemote(prepared.plan.inspection, fresh, prepared.plan.cache) || prepared.plan.pictures && !samePictures(prepared.plan.inspection, fresh))) invalidateReview('Overleaf files or review state changed.');
    projectData = await s.state.read(); inspection = projectedInspection(projectData); cache = stored; diffs.clear();
    cached = false; session = 'valid'; note = '';
    await syncReviewFiles(s); await draw(); await saveAnchorMemory(s); await status(undefined, { label: 'Overleaf changed', detail: 'Refresh', at: Date.now() }); paintStatus();
  }
  // Keeps each thread's last place and text, so it can still be shown after that text is deleted.
  async function saveAnchorMemory(s: SyncService) {
    if (service !== s) return;
    // A new thread's selection is not an Overleaf anchor until it has been sent.
    const unsent = new Set(projectData.pending.filter(draft => draft.kind === 'createThread').map(draft => draft.threadId));
    const anchors = cache.anchors;
    if (rememberAnchors(cache, rows.filter(row => !unsent.has(row.thread.id)))) await s.state.update(data => { data.anchors = anchors; }).catch(error => host.output.appendLine(`Comment positions not saved: ${safeError(error)}`));
  }
  // `startup`: the window just opened with automatic checks on. The cached review is shown
  // as "Checking Overleaf…" until checkNow's first read ends, not as stale and signed out.
  async function restoreCached(options: { startup?: boolean } = {}) {
    if (options.startup && automaticChecks()) checking = true;
    const s = await setup(); projectData = await s.state.read(); inspection = projectedInspection(projectData); cached = true;
    await syncReviewFiles(s);
    if (inspection) { await draw(); await saveAnchorMemory(s); await status(undefined, { label: 'cached review opened', at: Date.now() }); } else paintStatus();
    return s;
  }
  // The first switch to fast send states its risk once; Keep full switches it back.
  async function confirmFastSend() {
    if (config().get<string>('sendCheck', 'full') !== 'fast' || context.globalState.get<boolean>('turnleaf.fastSendConfirmed') || context.extensionMode === vscode.ExtensionMode.Test) return;
    const choice = await vscode.window.showWarningMessage('Fast send re-reads only the files Overleaf reported as edited over the live connection, and the files it writes.', { modal: true, detail: 'An edit that Overleaf fails to report is not seen before writing, and the check after writing catches it only in a file this Send wrote. Without a live connection, Send still reads every file.' }, 'Use fast', 'Keep full');
    if (choice === 'Use fast') { await context.globalState.update('turnleaf.fastSendConfirmed', true); return; }
    const setting = config().inspect<string>('sendCheck'), target = setting?.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder : setting?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await config().update('sendCheck', 'full', target);
  }
  async function checkNow() {
    if (!checking) return;
    const s = service;
    try { if (s && inspection) await host.background(checkRemote); }
    catch (error) { if (!(error instanceof SyncError && error.code === 'cancelled')) host.output.appendLine(`Remote check: ${safeError(error)}`); }
    finally { if (service === s) { checking = false; paintStatus(); } }
  }
  async function ensure() { if (!service) await restoreCached(); if (!inspection) { await refresh(); if (!inspection) throw new SyncError('Use Get latest and Apply to establish the local file and comment baseline first.', 'incoming'); } }
  // A thread ID, a native thread, or { value: id } from the project view.
  async function pick(argument?: string | vscode.CommentThread | { value?: unknown }): Promise<ReviewRow | undefined> {
    await ensure();
    const id = typeof argument === 'string' ? argument : argument && 'value' in argument ? typeof argument.value === 'string' ? argument.value : undefined : argument && ids.get(argument as vscode.CommentThread);
    if (id) return rows.find(r => r.thread.id === id);
    const choice = await vscode.window.showQuickPick(rows.map(row => ({ label: `${row.path}:${row.line || '?'} · ${row.thread.messages[0]?.author ?? row.thread.id}`, description: anchorLabel(row.anchor.label), detail: row.thread.messages[0]?.text, row })), { title: 'Choose an Overleaf thread' });
    return choice?.row;
  }
  async function openThread(argument?: string | vscode.CommentThread | { value?: unknown }) {
    const row = await pick(argument); if (!row) return;
    selectedThread = row.thread.id;
    const uri = vscode.Uri.joinPath(vscode.Uri.file(service!.root), row.path);
    const visible = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === uri.toString());
    const editor = await vscode.window.showTextDocument(uri, { viewColumn: visible?.viewColumn ?? lastSource?.viewColumn ?? vscode.ViewColumn.Active, preserveFocus: false });
    const range = rowRange(row, editor.document); editor.selection = new vscode.Selection(range.start, range.end); editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    // A comment without a marker gets its thread while it is the one opened.
    // It keeps it while it stays the last one opened, so typing on its blank line does not close it.
    const missing = !threads.some(t => ids.get(t) === row.thread.id); revealedThread = row.thread.id;
    if (missing) await draw();
    const thread = threads.find(t => ids.get(t) === row.thread.id); if (thread) thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    await draw();
  }
  async function previewLocal(i: Inspection) {
    for (const d of i.docs) await vscode.commands.executeCommand('vscode.diff', host.text(d.path, d.text), vscode.Uri.joinPath(vscode.Uri.file(service!.root), d.path), `Overleaf ↔ local: ${d.path}`);
  }
  function dirtyTracked(s: SyncService): vscode.TextDocument[] {
    return vscode.workspace.textDocuments.filter(d => d.isDirty && d.uri.scheme === 'file' && (s.paths.includes(relative(s.root, d.uri.fsPath).replace(/\\/g, '/')) || isReviewFile(s, d.uri)));
  }
  function isReviewFile(s: SyncService, uri: vscode.Uri): boolean {
    const path = relative(s.root, uri.fsPath).replace(/\\/g, '/');
    return uri.scheme === 'file' && (path.startsWith(`.turnleaf/projects/${s.state.key}/review/threads/`) || path.startsWith(`.turnleaf/projects/${s.state.key}/review/new/`)) && path.endsWith('.json');
  }
  async function syncReviewFiles(s: SyncService) {
    if (service !== s || vscode.workspace.textDocuments.some(d => d.isDirty && isReviewFile(s, d.uri))) return;
    try {
      const files = new LocalReviewFiles(s.state), enabled = !!(await s.state.read()).reviewFiles;
      let changed = false;
      if (!reviewFilesOn()) { if (enabled) await files.disable(); }
      else changed = enabled ? await files.sync() : await files.enable();
      if (service !== s) return;
      reviewFilesError = '';
      const stored = await s.state.read();
      if (changed || fingerprint(stored.pending) !== fingerprint(projectData.pending)) {
        projectData = stored; inspection = projectedInspection(projectData); computed.clear(); diffs.clear();
        if (prepared && fingerprint(prepared.plan.pending) !== fingerprint(stored.pending) || activeSend) invalidateReview('Local comment JSON changed. Review again.');
        note = REVIEW_FILES_IMPORTED;
      }
    } catch (error) {
      if (service !== s) return;
      const message = safeError(error);
      if (reviewFilesError !== message) host.output.appendLine(`Local review files: ${message}`);
      reviewFilesError = message; invalidateReview(message);
    }
  }
  function scheduleReviewFiles(s: SyncService) {
    clearTimeout(reviewFilesTimer);
    reviewFilesTimer = setTimeout(() => {
      reviewFilesTimer = undefined;
      if (service !== s || disposed) return;
      void host.background(async () => { await syncReviewFiles(s); if (service === s) { await draw(); await status(undefined, { label: 'comment files changed', at: Date.now() }); paintStatus(); } })
        .then(ran => { if (!ran && service === s && !disposed) scheduleReviewFiles(s); })
        .catch(error => host.output.appendLine(`Local review files: ${safeError(error)}`));
    }, 250);
  }
  async function saveTracked(s: SyncService, label: string): Promise<boolean> {
    const documents = dirtyTracked(s);
    if (!documents.length) return true;
    if (await vscode.window.showInformationMessage(`${documents.length} source or comment JSON file(s) have unsaved changes.`, { modal: true }, label) !== label) return false;
    for (const doc of documents) if (!await doc.save()) throw new SyncError(`Could not save ${doc.fileName}.`, 'stale');
    if (dirtyTracked(s).length) throw new SyncError('A source file changed while saving. Save it before reviewing.', 'stale');
    return true;
  }
  function invalidateReview(reason: string) {
    if (activeSend) activeSend.stale ??= reason;
    if (!prepared || prepared.complete || prepared.stale) return;
    prepared.stale = reason; paintStatus();
  }
  async function acceptInspection(s: SyncService, value: Inspection, cause: Cause = { label: 'Overleaf changed', detail: 'Overleaf read', at: Date.now() }) {
    if (service !== s) throw new SyncError('Project settings changed during the read.', 'configuration');
    // Write and redraw only when something changed: the displayed comments come
    // from the acknowledged state and local drafts, not from each remote read.
    const before = projectData, stored = await s.state.read();
    if (!stored.observed || !sameRemote(stored.observed, value) || !samePictures(stored.observed, value)) await s.saveRefresh(value);
    projectData = await s.state.read();
    await syncReviewFiles(s);
    const redraw = !inspection || cached || before.revision !== projectData.revision || fingerprint(before.pending) !== fingerprint(projectData.pending);
    if (redraw) { inspection = projectedInspection(projectData); diffs.clear(); }
    cached = false; session = 'valid'; cache = await s.state.cache();
    checkedAt = new Date().toISOString(); freshness = FRESHNESS.justChecked;
    if (redraw) await draw();
    await saveAnchorMemory(s);
    await status(undefined, cause);
  }
  function kept(f: { firstSync?: boolean; conflict: boolean; before: string; after: string }) { return !!f.firstSync && !f.conflict && f.after === f.before; }
  function previewFiles(p = prepared) {
    return p ? p.plan.files.map(f => ({ path: f.path, added: f.added, removed: f.removed, conflict: f.conflict, firstSync: f.firstSync, kept: kept(f),
      note: f.conflict ? conflictNotes.get(f.path) ?? (resolutionPaths.has(f.path) ? 'Edit the merged copy and save it; the saved copy is used automatically.' : undefined)
        : f.firstSync ? f.after === f.before ? 'Your version kept. It is then listed as going out to Overleaf.' : f.after === f.remote ? 'Overleaf version used. Your copy stays in Sync history.' : 'Manual merge used.' : undefined })) : [];
  }
  function previewPictures(p = prepared) {
    return p?.plan.pictures?.map(f => ({ path: f.path, summary: pictureSummary(f), conflict: pictureConflict(f), choose: f.kind === 'both', note: f.note }));
  }
  /**
   * A picture row: Overleaf's copy beside the local one. PNG and JPG open in the
   * editor's image comparison; a PDF opens both copies in the system viewer.
   */
  async function openPicture(p: PreparedReview, path: string) {
    const picture = p.plan.pictures?.find(f => f.path === path);
    if (!picture) throw new SyncError('This picture is outside the preview.', 'configuration');
    selectedDiff = `picture:${path}`; renderPanel();
    const local = picture.local ? vscode.Uri.joinPath(vscode.Uri.file(p.source.root), path) : undefined, remote = picture.download ? vscode.Uri.file(picture.download) : undefined;
    if (/\.pdf$/i.test(path)) {
      for (const uri of [local, remote]) if (uri && !await vscode.env.openExternal(uri)) throw new SyncError(`Could not open ${path} in the system viewer.`, 'configuration');
      return;
    }
    if (local && remote) await vscode.commands.executeCommand('vscode.diff', local, remote, `${path} · local → Overleaf`, { preview: true });
    else if (local ?? remote) await vscode.commands.executeCommand('vscode.open', local ?? remote, { preview: true });
  }
  // A read-only diff of file text, with the lines where comment changes apply marked.
  async function showDiff(path: string, before: string, after: string, sides: [string, string], title: string, comments: CommentChange[], incoming: boolean) {
    const beforeUri = host.text(`${sides[0]}/${path}`, before), afterUri = host.text(`${sides[1]}/${path}`, after);
    previewColors.add(beforeUri, afterUri, before, after, comments.filter(change => change.path === path).map(change => ({ line: rows.find(row => row.thread.id === change.threadId)?.line || change.line || 0, text: commentNote(change, incoming) })).filter(note => note.line > 0));
    await vscode.commands.executeCommand('vscode.diff', beforeUri, afterUri, title, { preview: true });
    previewColors.paint(); renderPanel();
  }
  async function openPreviewDiff(arg?: { path?: string; preview?: string; value?: string }) {
    const p = prepared;
    if (!p || arg?.preview && arg.preview !== p.id) throw new SyncError('This preview is no longer available. Get latest again.', 'stale');
    if (arg?.value === 'picture' && arg.path) return openPicture(p, arg.path);
    const paths = previewFiles(p);
    if (!arg?.path && !paths.length && p.plan.pictures?.length) return openPicture(p, p.plan.pictures[0].path);
    const path = arg?.path ?? (paths.length === 1 ? paths[0].path : (await vscode.window.showQuickPick(paths.map(f => ({ label: f.path, description: `+${f.added} −${f.removed}` })), { title: 'Choose a diff to review' }))?.label);
    if (!path) return;
    const file = p.plan.files.find(f => f.path === path);
    if (!file) throw new SyncError('This file is outside the preview.', 'configuration');
    selectedDiff = path;
    await showDiff(path, file.before, file.after, diffSides.merge, diffTabTitle(path, 'merge', !!p.stale), p.plan.comments, true);
  }
  // A file row of the outgoing summary (value ''), of its Overleaf group ('incoming') or of the undo summary ('undo').
  async function openOutgoingDiff(arg?: { path?: string; value?: string }) {
    const path = arg?.path, plan = standing?.plan; if (typeof path !== 'string') return;
    const gone = () => new SyncError('This file is no longer in the summary.', 'stale');
    if (arg?.value === 'picture' || arg?.value === 'undo-picture') {
      const pictures = arg.value === 'picture' ? plan?.pictures : undoing?.plan?.plan.pictures, picture = pictures?.find(f => f.path === path); if (!picture) throw gone();
      selectedDiff = `${arg.value}:${path}`; renderPanel();
      return comparePicture(standing?.plan?.inspection ?? undoing?.plan?.plan.inspection, picture, arg.value === 'undo-picture');
    }
    if (arg?.value === 'undo') {
      const file = undoing?.plan?.plan.files.find(f => f.doc.path === path); if (!file) throw gone();
      selectedDiff = `undo:${path}`;
      await showDiff(path, file.doc.text, file.text, diffSides.undo, diffTabTitle(path, 'undo'), [], false);
    } else if (arg?.value === 'incoming') {
      const file = plan?.incoming?.files.find(f => f.path === path); if (!file) throw gone();
      selectedDiff = `incoming:${path}`;
      await showDiff(path, file.before, file.after, diffSides.merge, diffTabTitle(path, 'merge'), plan!.incoming!.comments, true);
    } else {
      const file = plan?.files.find(f => f.doc.path === path); if (!file) throw gone();
      selectedDiff = path;
      await showDiff(path, file.doc.text, file.text, diffSides.send, diffTabTitle(path, 'send'), plan!.comments, false);
    }
  }
  /**
   * A picture row of the outgoing or undo summary, side by side: Overleaf's copy now
   * and what the row leaves there (the local copy, or for an undo the replaced one).
   * Copies come from the local folder, Sync history or a download by hash.
   */
  async function comparePicture(overleaf: Inspection | undefined, picture: OutgoingPicture, undo: boolean) {
    const s = await setup(), path = picture.path, extension = path.slice(path.lastIndexOf('.')).toLowerCase();
    const local = vscode.Uri.joinPath(vscode.Uri.file(s.root), path);
    const copy = async (hash: string, id?: string): Promise<vscode.Uri | undefined> => {
      const target = await s.state.picturePath(`compare/${hash}${extension}`);
      const known = await readFile(target).then(bytes => gitBlobSha1(bytes) === hash, () => false);
      if (known) return vscode.Uri.file(target);
      const bytes = await readFile(local.fsPath).then(bytes => gitBlobSha1(bytes) === hash ? bytes : undefined, () => undefined)
        ?? await s.state.getBytes(hash) ?? (id ? await (await s.remote()).downloadFile(s.projectId, path, { id, hash }, overleaf?.maxUploadSize) : undefined);
      if (!bytes) return;
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const temp = `${target}.${randomUUID()}.tmp`; await writeFile(temp, bytes, { mode: 0o600 }); await rename(temp, target);
      return vscode.Uri.file(target);
    };
    const now = overleaf?.tree?.fileRefs?.[path], remote = picture.remote ?? (now?.hash ? { id: now.id, hash: now.hash } : undefined);
    const before = remote ? await copy(remote.hash, remote.id) : undefined;
    const after = picture.kind === 'delete' ? undefined : undo ? picture.hash ? await copy(picture.hash, remote?.id) : undefined : local;
    if (/\.pdf$/i.test(path)) {
      for (const uri of [before, after]) if (uri && !await vscode.env.openExternal(uri)) throw new SyncError(`Could not open ${path} in the system viewer.`, 'configuration');
      return;
    }
    const title = diffTitle(path, undo ? 'undo' : 'send');
    if (before && after) await vscode.commands.executeCommand('vscode.diff', before, after, title, { preview: true });
    else if (before ?? after) await vscode.commands.executeCommand('vscode.open', before ?? after, { preview: true });
  }
  async function pull() {
    const s = await setup();
    if (!await saveTracked(s, 'Save & preview')) return;
    const workflow = new ReviewWorkflow(s);
    const plan = await workflow.preparePull();
    if (service !== s || dirtyTracked(s).length) throw new SyncError('Workspace changed while preparing the preview. Get latest again.', 'stale');
    prepared = { id: randomUUID(), kind: 'pull', plan, source: s, created: Date.now() }; resolutionPaths.clear(); conflictNotes.clear();
    if (!pullChanges(plan) && plan.revision && !plan.cache.partialPush && projectData.acknowledged && sameContent(projectData.acknowledged, plan.inspection)) prepared.complete = 'Local files and comments are up to date. Unsent local edits are preserved.';
    await acceptInspection(s, plan.inspection); await showOverview();
    if (plan.files.length) await openPreviewDiff({ path: plan.files[0].path });
  }
  // Leaves a virtual diff for the real source before local files are written.
  async function showLocalSource(s: SyncService, after: SavedTexts, saved: SavedTexts, applied = false) {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.uri.scheme !== 'overleaf-inspection') return;
    const paths = s.paths.filter(path => after[path] !== saved[path] && (applied || saved[path] !== null));
    const selected = selectedDiff?.replace(/^(incoming|undo):/, '');
    const path = selected && paths.includes(selected) ? selected : paths[0];
    if (!path) return;
    // A file update can trigger LaTeX Workshop's build and SyncTeX navigation.
    // Leave the virtual diff before writing so it navigates the real source.
    // Newly created files can only be opened after Apply has written them.
    try { await vscode.window.showTextDocument(vscode.Uri.joinPath(vscode.Uri.file(s.root), path), { viewColumn: editor.viewColumn, preview: false }); }
    catch (error) { host.output.appendLine(`Could not open local source ${path}: ${safeError(error)}`); }
  }
  async function applyReviewed(arg?: { preview?: string }) {
    const p = prepared;
    if (!p || p.stale || p.complete || arg?.preview && arg.preview !== p.id) throw new SyncError('Prepare a fresh Get latest preview first.', 'stale');
    if (Date.now() - p.created < 650) return;
    const s = p.source;
    applying = true;
    try {
      await showLocalSource(s, p.plan.proposed, p.plan.saved);
      const result = await new ReviewWorkflow(s).apply(p.plan, () => service === s && prepared === p && !p.stale && !dirtyTracked(s).length);
      p.complete = LOCAL_APPLIED;
      host.output.appendLine(`Local recovery checkpoint: ${result.checkpoint}`);
      await showLocalSource(s, p.plan.proposed, p.plan.saved, true);
      diskTexts.clear(); computed.clear(); await acceptInspection(s, p.plan.inspection, { label: 'local updates applied', at: Date.now() }); await status('Local updates applied');
    } catch (error) { invalidateReview(safeError(error)); throw error; }
    finally { applying = false; cache = await s.state.cache(); paintStatus(); }
  }

  // ---- The standing outgoing summary and its single Send ----
  const contentKey = (data: ProjectData) => fingerprint([data.revision, data.pending, data.localApply, data.partialSend, data.acknowledged?.fetchedAt, data.observed ?? data.acknowledged]);
  const rowCount = (plan?: PushPlan) => (plan?.files.length ?? 0) + (plan?.comments.length ?? 0) + (plan?.pictures?.filter(sendsPicture).length ?? 0);
  // The picture inputs of the summary: the picture state and the size and time of each local picture it may send.
  async function pictureKey(s: SyncService, overleaf?: Inspection): Promise<string> {
    if (!s.state.syncPictures()) return '';
    const state = await s.state.pictures(), paths = [...new Set([...Object.keys(state.baseline), ...state.added ?? [], ...Object.keys(remotePictures(overleaf))])].sort();
    return fingerprint([state, await Promise.all(paths.map(path => stat(vscode.Uri.joinPath(vscode.Uri.file(s.root), path).fsPath).then(info => [info.size, info.mtimeMs, info.ino], () => null)))]);
  }
  // `mark`: the inputs are known to have changed, so Send waits for the new summary.
  // `cause`: why, for "Updating: …" and the record. The first known change names the refresh.
  function scheduleStanding(mark = false, cause?: Cause) {
    if (!service || disposed) return;
    if (cause && (!pendingCause || mark && !pendingMarked)) { pendingCause = cause; pendingMarked = mark; }
    if (mark && !standingBusy) { standingBusy = true; renderPanel(); }
    clearTimeout(standingTimer);
    standingTimer = setTimeout(() => { standingTimer = undefined; void computeStanding().catch(error => host.output.appendLine(`Outgoing summary: ${safeError(error)}`)); }, 300);
  }
  async function computeStanding() {
    const s = service, run = ++standingRun; if (!s) return;
    const cause = refreshCause = pendingCause ?? refreshCause ?? { label: 'summary check', at: Date.now() }; pendingCause = undefined; pendingMarked = false;
    // A refresh is logged when it shows (Send waits) or its inputs changed; a check that finds them unchanged is not.
    let logged = false, ended = 'unchanged';
    const begin = () => { if (!logged) { logged = true; host.output.appendLine(`Summary refresh started (${causeText(cause)})`); } };
    const stale = () => { const gone = run !== standingRun || service !== s; if (gone) ended = 'superseded by a newer refresh'; return gone; };
    if (standingBusy) begin();
    try {
      const saved = await readSaved(s.root, s.paths, true), follow = await s.state.followSelections(saved);
      if (stale()) return;
      unplacedDrafts = new Set(follow.unplaced);
      if (follow.moved.length) { projectData = await s.state.read(); inspection = projectedInspection(projectData); computed.clear(); diffs.clear(); scheduleReviewFiles(s); scheduleDraw(); }
      const data = await s.state.read(), overleaf = data.observed ?? data.acknowledged, key = contentKey(data) + await pictureKey(s, overleaf);
      if (stale()) return;
      if (standingInputs?.key === key && sameSaved(saved, standingInputs.saved)) return;
      begin();
      const before = standing, workflow = new ReviewWorkflow(s);
      const result = overleaf ? await workflow.planSend(data, overleaf, saved) : { blocked: { way: 'getLatest' as const, message: 'Get latest to establish the local sync baseline.', code: 'incoming' } };
      if (stale()) return;
      const same = !!before && (before.plan && result.plan ? !planDifferences(before.plan, result.plan).length : !before.plan && !result.plan && before.blocked?.message === result.blocked?.message);
      standing = { plan: result.plan, blocked: result.blocked, marks: result.plan && irreversible(result.plan), changedAt: same ? before!.changedAt : Date.now(), cause: same ? before!.cause : cause, ...same && { changed: before!.changed, notice: before!.notice } };
      standingInputs = { key, saved };
      if (!same) { ended = `summary changed: ${rowCount(result.plan)} ${rowCount(result.plan) === 1 ? 'row' : 'rows'}${result.blocked ? ', Send blocked' : ''}`; pressNote = undefined; }
      else ended = 'summary unchanged';
      // A message about an earlier state gives way to the new summary; the report of an undo stays once.
      if (before && !same) {
        if (prepared?.complete) prepared = undefined;
        if (rowCount(result.plan) || result.blocked) { if (noteHold) noteHold = false; else note = ''; }
      }
      if (undoing) await computeUndo(s, data, overleaf, saved, cause);
    } catch (error) { ended = `failed: ${safeError(error)}`; throw error; }
    finally {
      if (run === standingRun) { standingBusy = false; refreshCause = undefined; paintStatus(); }
      if (logged) host.output.appendLine(`Summary refresh ended: ${ended}`);
    }
  }
  async function computeUndo(s: SyncService, data: ProjectData, overleaf: Inspection | undefined, saved: SavedTexts, cause: Cause = { label: 'undo summary opened', at: Date.now() }) {
    const u = undoing; if (!u) return;
    const [record] = await s.state.history(u.record).catch(() => []);
    const result = overleaf ? await new ReviewWorkflow(s).planUndo(record, data, overleaf, saved) : { blocked: { way: 'getLatest' as const, message: 'Get latest to establish the local sync baseline.', code: 'incoming' } };
    if (undoing !== u || service !== s) return;
    const same = u.plan && result.plan ? !undoDifferences(u.plan, result.plan).length : !u.plan && !result.plan && u.blocked?.message === result.blocked?.message;
    undoing = { record: u.record, time: record?.time ?? u.time, plan: result.plan, blocked: result.blocked, changedAt: same ? u.changedAt : Date.now(), cause: same ? u.cause : cause, ...same && { changed: u.changed, notice: u.notice } };
    if (!same) pressNote = undefined;
  }
  const undoDifferences = (shown: UndoPlan, next: UndoPlan) => [...planDifferences(shown.plan, next.plan), ...fingerprint(shown.stays) === fingerprint(next.stays) ? [] : ['stays']];
  // What a press on Send or Send undo needs before any request is made. A result: it does
  // not send, and the summary says why (pressNotice). A refusal shows its message as before.
  function clickAllowed(s: SyncService, shown: Shown | undefined): ActionResult | undefined {
    if (prepared && !prepared.complete) throw new Refusal('preview-open', 'Apply or close the Get latest preview first.', 'stale');
    const gate = sendGate({ shown, refreshing: standingBusy, refreshCause: refreshCause ?? pendingCause, sending, now: Date.now() });
    if (gate) return gate;
    if (shown!.blocked) throw new Refusal('blocked', shown!.blocked.message, shown!.blocked.code);
    if (dirtyTracked(s).length) throw new Refusal('unsaved-files', 'Save the selected files first: unsaved edits are not in the summary.', 'stale');
    if (!writes()) throw new Refusal('sending-off', 'Enable sending in Project setup first.', 'read-only');
  }
  const summaryChanged = (what: string) => host.output.appendLine(`Summary changed: ${what}`);
  const verification = (result: { mismatches: string[]; warnings: string[] }) => result.mismatches.length ? 'mismatch' as const : result.warnings.length ? 'warnings' as const : 'verified' as const;
  function sendOutcome(result: { mismatches: string[]; warnings: string[] }, done: string) {
    return result.mismatches.length ? 'Verification failed. Get latest before sending again.' : result.warnings.length ? 'Upload verified with concurrency warnings. Review the result and project history.' : done;
  }
  // The confirmation before an irreversible Send. The editor test answers it in place of the modal.
  const testAnswers: (string | undefined)[] = [];
  const confirm = (message: string, detail: string, button: string) => context.extensionMode === vscode.ExtensionMode.Test && testAnswers.length
    ? Promise.resolve(testAnswers.shift()) : vscode.window.showWarningMessage(message, { modal: true, detail }, button);
  // One click: a fresh read of Overleaf and of the saved files, and a send only when
  // the fresh plan equals the summary that was shown. Otherwise nothing is written
  // and the summary shows the fresh plan with the differing rows marked.
  async function send(): Promise<ActionResult> {
    const s = await setup(), current = standing;
    const refused = clickAllowed(s, current); if (refused) return refused;
    const shown = current!;
    if (!shown.plan || !rowCount(shown.plan)) return { outcome: 'nothing-to-send' };
    if (prepared?.complete) prepared = undefined;
    const deletions = shown.plan.pending.filter(draft => draft.kind === 'deleteThread' || draft.kind === 'deleteMessage');
    if (deletions.length && await confirm(`Send, including ${deletions.length} comment deletion(s)?`, 'These deletions remove content from Overleaf for collaborators and cannot be undone. They are marked in the summary.', 'Send') !== 'Send') return { outcome: 'confirmation-declined' };
    const workflow = new ReviewWorkflow(s), active = activeSend = { saved: shown.plan.saved } as { saved: SavedTexts; stale?: string };
    sending = true; renderPanel();
    let wrote = false;
    try {
      let plan: PushPlan;
      try { plan = await workflow.prepareSend(); }
      catch (error) {
        // A stop found by the fresh read is shown in the summary, like any other difference.
        const data = await s.state.read(), overleaf = data.observed ?? data.acknowledged;
        const now = error instanceof SyncError && overleaf ? await workflow.planSend(data, overleaf, await readSaved(s.root, s.paths, true)) : undefined;
        if (!now?.blocked) throw error;
        const cause = { label: 'fresh read at Send', at: Date.now() };
        standing = { blocked: now.blocked, changedAt: cause.at, cause, notice: 'Nothing was sent: the summary changed since it was shown.' }; standingInputs = undefined;
        summaryChanged(`the fresh read at Send found a stop (${causeText(cause)})`);
        await showOverview(); return { outcome: 'summary-changed', nowBlocked: true };
      }
      if (service !== s || active.stale || dirtyTracked(s).length) throw new Refusal('workspace-changed', `Nothing was sent: ${active.stale ?? 'the workspace changed while preparing to send.'}`, 'stale');
      const changed = planDifferences(shown.plan, plan);
      if (changed.length) {
        const overleaf = !sameContent(shown.plan.inspection, plan.inspection), cause = { label: overleaf ? 'Overleaf changed' : 'fresh read at Send', detail: 'fresh read at Send', at: Date.now() };
        standing = { plan, marks: irreversible(plan), changedAt: cause.at, cause, changed, notice: `${overleaf ? 'Overleaf changed since this summary was shown' : 'The summary changed since it was shown'}. Nothing was sent: check the marked rows, then send again.` };
        summaryChanged(`${changed.length} ${changed.length === 1 ? 'row' : 'rows'} differ at Send; ${overleaf ? 'Overleaf changed' : 'Overleaf unchanged'} (${causeText(cause)})`);
        await acceptInspection(s, plan.inspection, cause); await showOverview();
        return { outcome: 'summary-changed', rows: changed.length, overleaf };
      }
      // Combined send: apply the incoming changes first, exactly like Get latest →
      // Apply, then send against the state that was acknowledged. Rejected
      // suggestions also rewrite local files at the end of Send. Local writes do
      // not stop this send while `applying` is set.
      const combined = !!plan.incoming, rewrites = s.paths.some(path => plan.local[path] !== plan.saved[path]); if (combined || rewrites) applying = true;
      const valid = () => service === s && !active.stale && writes() && !dirtyTracked(s).length;
      if (combined || rewrites) await showLocalSource(s, plan.local, plan.saved);
      if (plan.incoming) {
        wrote = true;
        const applied = await workflow.apply(plan.incoming, valid);
        await showLocalSource(s, plan.local, plan.saved, true);
        plan = workflow.afterIncoming(plan, applied); diskTexts.clear(); computed.clear();
        host.output.appendLine(`Applied incoming changes before sending; recovery checkpoint ${applied.checkpoint}.`);
      }
      wrote = true;
      const result = await s.push(plan, valid, line => host.output.appendLine(line));
      if (rewrites) { diskTexts.clear(); computed.clear(); }
      const outcome = sendOutcome(result, SENT_VERIFIED);
      note = outcome; lastSent = result.mismatches.length || result.warnings.length ? undefined : { id: result.history, note: outcome };
      await acceptInspection(s, result.inspection, { label: 'Send finished', at: Date.now() });
      const report = ['# Send result', '', outcome, `Snapshot: ${result.snapshot}`, ...result.mismatches.map(path => `Verification mismatch: ${path}`), ...result.warnings, '', '## Comment anchors'];
      for (const file of plan.files) for (const predicted of file.mapping.comments) {
        const afterDoc = trackedInspection(result.inspection, cache).docs.find(doc => doc.path === file.doc.path);
        const actual = afterDoc?.comments.find(anchor => anchor.threadId === predicted.threadId), original = file.doc.comments.find(anchor => anchor.threadId === predicted.threadId);
        const oldText = original?.ranges.map(range => file.doc.text.slice(range.pos, range.pos + range.length)).join('');
        const newText = actual?.ranges.map(range => afterDoc!.text.slice(range.pos, range.pos + range.length)).join('');
        const actualLabel = actual?.state === 'placed' ? oldText !== newText ? 'anchor edited' : JSON.stringify(original?.ranges) !== JSON.stringify(actual.ranges) ? 'anchor moved' : 'unchanged' : actual?.state ?? 'thread unavailable';
        report.push(`- ${file.doc.path} · ${predicted.threadId}: predicted ${anchorLabel(predicted.label)}; observed ${anchorLabel(actualLabel)}.`);
      }
      report.push('', `Suggestions: ${plan.inspection.docs.reduce((n, doc) => n + doc.changes.length, 0)} before; ${result.inspection.docs.reduce((n, doc) => n + doc.changes.length, 0)} after.`);
      if (plan.pictures?.length) report.push('', '## Pictures', ...plan.pictures.map(picture => `- ${picture.path}: ${outgoingSummary(picture)}${sendsPicture(picture) ? ' · uploaded and read back' : ` · ${picture.note ?? ''}`}`));
      lastReport = report.join('\n');
      if (result.mismatches.length || result.warnings.length) await showReport();
      return { outcome: 'sent', rows: rowCount(plan), verification: verification(result) };
    } catch (error) { if (wrote && typeof error === 'object' && error) writesStarted.add(error); throw error; }
    finally { await afterSend(s, wrote); }
  }
  async function afterSend(s: SyncService, wrote: boolean) {
    sending = false; activeSend = undefined; applying = false;
    if (wrote) { diskTexts.clear(); computed.clear(); }
    if (service !== s) return;
    // Also after a stop: the stored state then names what the summary must show.
    try { projectData = await s.state.read(); cache = await s.state.cache(); await status(); } catch (error) { host.output.appendLine(safeError(error)); }
    scheduleStanding(true, { label: 'Send finished', at: Date.now() }); paintStatus(); void refreshHistory();
  }
  // Undo this send: the summary of what one Send record takes back, shown in place of the outgoing summary.
  async function undoSend(arg?: { value?: unknown }) {
    const s = await setup(); await ensure();
    if (typeof arg?.value !== 'string' || !/^[\w-]+$/.test(arg.value)) return;
    if (prepared && !prepared.complete) throw new SyncError('Apply or close the Get latest preview first.', 'stale');
    const data = await s.state.read();
    undoing = { record: arg.value, time: '', changedAt: Date.now() };
    await computeUndo(s, data, data.observed ?? data.acknowledged, await readSaved(s.root, s.paths, true));
    paintStatus(); await showOverview();
  }
  async function sendUndo(): Promise<ActionResult> {
    const s = await setup(), current = undoing;
    const refused = clickAllowed(s, current); if (refused) return refused;
    const shown = current!;
    if (!shown.plan || !rowCount(shown.plan.plan)) return { outcome: 'nothing-to-send' };
    if (prepared?.complete) prepared = undefined;
    const removed = [...shown.plan.plan.files.filter(file => file.remove).map(file => file.doc.path), ...(shown.plan.plan.pictures ?? []).filter(picture => picture.kind === 'delete').map(picture => picture.path)];
    if (removed.length && await confirm(`Send undo, deleting ${removed.join(', ')} from Overleaf?`, 'This Send created these files and they are unchanged since. Overleaf keeps deleted files restorable in its history; your local files stay.', 'Send undo') !== 'Send undo') return { outcome: 'confirmation-declined' };
    const workflow = new ReviewWorkflow(s), active = activeSend = { saved: shown.plan.plan.saved } as { saved: SavedTexts; stale?: string };
    sending = true; renderPanel();
    let wrote = false;
    try {
      let fresh: UndoPlan;
      try { fresh = await workflow.prepareUndo(shown.record); }
      catch (error) {
        const data = await s.state.read();
        const cause = { label: 'fresh read at Send undo', at: Date.now() };
        if (error instanceof SyncError) await computeUndo(s, data, data.observed ?? data.acknowledged, await readSaved(s.root, s.paths, true), cause);
        if (!undoing?.blocked) throw error;
        undoing.notice = 'Nothing was sent: Overleaf changed since this undo summary was shown.';
        summaryChanged(`the fresh read at Send undo found a stop (${causeText(cause)})`);
        await showOverview(); return { outcome: 'summary-changed', nowBlocked: true };
      }
      if (service !== s || undoing !== shown || active.stale || dirtyTracked(s).length) throw new Refusal('workspace-changed', `Nothing was sent: ${active.stale ?? 'the workspace changed while preparing the undo.'}`, 'stale');
      const changed = undoDifferences(shown.plan, fresh);
      if (changed.length) {
        const overleaf = !sameContent(shown.plan.plan.inspection, fresh.plan.inspection), cause = { label: 'Overleaf changed', detail: 'fresh read at Send undo', at: Date.now() };
        undoing = { record: shown.record, time: fresh.time, plan: fresh, changedAt: cause.at, cause, changed, notice: 'Overleaf changed since this undo summary was shown. Nothing was sent: check the marked rows, then send the undo again.' };
        summaryChanged(`${changed.length} undo ${changed.length === 1 ? 'row differs' : 'rows differ'} at Send undo; ${overleaf ? 'Overleaf changed' : 'Overleaf unchanged'} (${causeText(cause)})`);
        await acceptInspection(s, fresh.plan.inspection, cause); await showOverview();
        return { outcome: 'summary-changed', rows: changed.length, overleaf };
      }
      wrote = true;
      const result = await s.push(fresh.plan, () => service === s && !active.stale && writes() && !dirtyTracked(s).length, line => host.output.appendLine(line));
      note = sendOutcome(result, UNDO_SENT_VERIFIED); noteHold = !result.mismatches.length;
      undoing = undefined; lastSent = undefined;
      lastReport = ['# Undo result', '', note, `Undo of the send from ${new Date(fresh.time).toLocaleString()}`, `Snapshot: ${result.snapshot}`, ...result.mismatches.map(path => `Verification mismatch: ${path}`), ...result.warnings, ...fresh.stays.map(row => `Stays as sent: ${row.label}${row.path ? ` · ${row.path}` : ''}. ${row.reason}`)].join('\n');
      await acceptInspection(s, result.inspection, { label: 'Send undo finished', at: Date.now() });
      if (result.mismatches.length || result.warnings.length) await showReport();
      return { outcome: 'sent', rows: rowCount(fresh.plan), verification: verification(result) };
    } catch (error) { if (wrote && typeof error === 'object' && error) writesStarted.add(error); throw error; }
    finally { await afterSend(s, wrote); }
  }
  const showReport = () => vscode.window.showTextDocument(host.text('send-result.md', lastReport ?? ''));
  async function resolveConflict(arg: { path?: string; preview?: string }, useSaved: boolean) {
    const p = prepared;
    if (!p || p.stale || p.complete || arg?.preview !== p.id) throw new SyncError('Prepare a fresh merge preview first.', 'stale');
    const file = p.plan.files.find(f => f.path === arg.path && f.conflict);
    if (!file) throw new SyncError('Select a conflicting file.', 'conflict');
    let uri = resolutionPaths.get(file.path);
    if (useSaved) {
      if (!uri) throw new SyncError('Open Resolve in editor first, then save your resolution.', 'conflict');
      if (vscode.workspace.textDocuments.some(d => d.uri.toString() === uri!.toString() && d.isDirty)) throw new SyncError('Save the resolution before using it.', 'conflict');
      p.plan = new ReviewWorkflow(p.source).resolve(p.plan, file.path, await readFile(uri.fsPath, 'utf8')); p.created = Date.now();
      paintStatus(); await openPreviewDiff({ path: file.path, preview: p.id }); return;
    }
    if (!uri) {
      // This is an editable scratch copy, not a compilable project source.
      // A .tex scratch file can trigger LaTeX Workshop's build-on-save.
      const path = await p.source.state.path(`cache/merges/${p.id}/${file.path}.resolution.txt`);
      await mkdir(dirname(path), { recursive: true }); await writeFile(path, file.after); uri = vscode.Uri.file(path); resolutionPaths.set(file.path, uri);
    }
    await vscode.languages.setTextDocumentLanguage(await vscode.workspace.openTextDocument(uri), 'plaintext');
    await vscode.commands.executeCommand('vscode.diff', host.text(`Local-current/${file.path}`, file.before), uri, `${file.path} · edit the merged copy; saving uses it`); renderPanel();
  }
  async function checkRemote() {
    try {
    const s = await setup(), fresh = await s.fetchPull();
    if (service === s) await observe(s, fresh, { label: 'Overleaf changed', detail: 'remote check', at: Date.now() });
    } catch (error) { if (!(error instanceof SyncError && error.code === 'cancelled')) { freshness = 'Remote state unknown · check failed'; paintStatus(); } throw error; }
  }
  async function observe(s: SyncService, fresh: Inspection, cause: Cause) {
    const p = prepared;
    if (p && !p.complete && (!sameRemote(p.plan.inspection, fresh, p.plan.cache) || p.plan.pictures && !samePictures(p.plan.inspection, fresh))) invalidateReview('Overleaf files, comments or suggestions changed.');
    const data = await s.state.read();
    if (p && !p.complete && (!sameSaved(await readSaved(s.root, s.paths, true), p.plan.saved) || dirtyTracked(s).length || data.revision !== p.plan.revision || fingerprint(data.pending) !== fingerprint(p.plan.pending))) invalidateReview('Saved files, comment drafts, or the sync baseline changed.');
    await acceptInspection(s, fresh, cause);
    freshness = needsPull ? FRESHNESS.incoming : live ? FRESHNESS.live : FRESHNESS.quiet; poller.succeeded(); paintStatus();
  }
  function scheduleCheck() {
    // With live updates, events carry changes and a 60-second check over the same
    // connection is the safety net (and reconnects after a dropped connection).
    const seconds = config().get<number>('remoteCheckInterval', 10), interval = liveEnabled() ? 60 : [10, 30, 60].includes(seconds) ? seconds : 0;
    poller.configure(disposed || !service || context.extensionMode === vscode.ExtensionMode.Test || session === 'expired' || session === 'signedOut' ? 0 : interval);
  }
  // The larger view's second column: the whole thread with its source context.
  function threadDetail(row: ReviewRow | undefined): ThreadDetail | undefined {
    if (!row) return;
    const text = computed.get(row.path)?.text ?? '', ranges = row.anchor.ranges.filter(r => r.length > 0);
    const anchorText = ranges.map(r => text.slice(r.pos, r.pos + r.length)).join(' … ');
    const lines = text.split('\n'), lineOf = (pos: number) => text.slice(0, pos).split('\n').length;
    const first = ranges.length ? lineOf(ranges[0].pos) : row.line, last = ranges.length ? lineOf(ranges.at(-1)!.pos + ranges.at(-1)!.length) : row.line;
    const context = first ? lines.slice(Math.max(0, first - 2), Math.min(lines.length, Math.min(last, first + 5) + 1)).map((line, n) => ({ line: Math.max(1, first - 1) + n, text: line, anchored: !textGone(row.anchor.label) && Math.max(1, first - 1) + n >= first && Math.max(1, first - 1) + n <= last })) : [];
    return { row, anchorText, context };
  }
  function view(): ProjectView {
    // Keep the last source's comments when its editor is replaced by a diff tab.
    const path = lastSource && service && relative(service.root, lastSource.document.uri.fsPath).replace(/\\/g, '/');
    const visible = rows.filter(r => (allComments || r.path === path) && (!author || r.thread.messages.some(m => m.author === author)));
    // Applied incoming changes belong in Sync history, not in the current diff.
    const p = prepared?.complete ? undefined : prepared;
    return { name: inspection?.projectName ?? projectData.observed?.projectName ?? service?.projectId, server: config().get<string>('baseUrl'), files: service?.paths ?? config().get<string[]>('trackedFiles', []), state: stateLabel(), fetchedAt: inspection?.fetchedAt, writes: writes(), activePath: path, rows: visible, reviews, connected: session === 'valid', checking, linked: !!config().get<string>('projectId'), busy: host.isBusy(), interval: liveEnabled() ? 'live' : config().get('remoteCheckInterval', 10), live: !!live, checkedAt, freshness, recovery: !!cache.localApply, allComments, drafts: projectData.pending.map(draft => ({ id: draft.id, kind: draft.kind, path: draft.path, threadId: draft.threadId, text: draft.text, uncertain: draft.uncertain, ...draftPlace(draft),
        ...(unplacedDrafts.has(draft.id) || draft.kind === 'createThread' && standing?.blocked?.draftId === draft.id) && { unplaced: true }, ...draft.change && { suggestion: { kind: draft.change.kind, text: draft.change.text } } })),
      version: context.extension.packageJSON.version, suggestionRows: suggestionRows.filter(s => allComments || s.path === path),
      outgoing: outgoingView(), undo: undoView(), undoLatest: lastSent && note === lastSent.note && !undoing && !p ? lastSent.id : undefined,
      detail: panel ? threadDetail(rows.find(r => r.thread.id === selectedThread)) : undefined,
      openComments: rows.filter(r => !r.thread.resolved).length, suggestions: inspection?.docs.reduce((n, d) => n + d.changes.length, 0) ?? 0, selectedThread, highlightComments, outlineMarkers: markers.enabled(), userId: inspection?.userId, reviewFilter, reviewFiles: reviewFilesOn(), commentMarkers: config().get<string>('commentMarkers', 'belowParagraph') === 'commentedLine' ? 'commentedLine' : 'belowParagraph', deletionDisplay: deletionDisplaySetting(),
      preview: p && { id: p.id, stale: p.stale, complete: p.complete, files: previewFiles(p), pictures: previewPictures(p), comments: p.plan.comments, selectedPath: selectedDiff } };
  }
  const unsavedNames = () => service ? dirtyTracked(service).map(d => isReviewFile(service!, d.uri) ? 'comment JSON' : relative(service!.root, d.uri.fsPath).replace(/\\/g, '/')) : [];
  const keyed = (keys: string[] | undefined, prefix: string) => (keys ?? []).filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length));
  // Where Show in editor goes for a draft: its thread, or the suggestion a decision is about.
  function draftPlace(draft: CommentDraft | undefined): { place?: Place; line?: number } {
    if (!draft) return {};
    if (isDecision(draft)) {
      const row = suggestionRows.find(s => s.id === draft.change?.id && s.path === draft.path);
      return row ? { place: { command: 'openSuggestion', path: row.path, value: String(row.pos) }, line: row.line } : {};
    }
    const row = rows.find(r => r.thread.id === draft.threadId);
    return row ? { place: { command: 'openThread', value: row.thread.id }, ...row.line && { line: row.line } } : {};
  }
  function places(changes: CommentChange[] | undefined): Record<string, Place> {
    const result: Record<string, Place> = {};
    for (const c of changes ?? []) {
      const place = c.draftId || c.suggestion ? draftPlace(projectData.pending.find(d => d.id === (c.draftId ?? c.id))).place
        : c.threadId && rows.some(r => r.thread.id === c.threadId) ? { command: 'openThread' as const, value: c.threadId } : undefined;
      if (place) result[c.id] = place;
    }
    return result;
  }
  // Send waits while the summary is recomputed and for 650 ms after it changed, so the owner sees what is sent.
  // A render at the end of that wait enables Send again.
  function sendWait(shown: Shown): Pick<OutgoingView, 'sendWait' | 'updating' | 'pressNotice'> {
    const left = shown.changedAt + SETTLE_MS - Date.now();
    if (left > 0 && !settleTimer) settleTimer = setTimeout(() => { settleTimer = undefined; renderPanel(); }, left + 10);
    const refreshing = standingBusy || left > 0, cause = standingBusy ? refreshCause ?? pendingCause : shown.cause;
    return { ...sending ? { sendWait: 'sending' as const } : refreshing && { sendWait: 'refreshing' as const, updating: cause?.label ?? 'summary check' }, ...pressNote && { pressNotice: pressNote } };
  }
  function outgoingView(): OutgoingView | undefined {
    const st = standing; if (!st || !inspection || !service) return;
    const plan = st.plan, changed = new Set(st.changed), unsaved = unsavedNames();
    return { busy: standingBusy || sending, ...sendWait(st), notice: st.notice, selectedPath: selectedDiff, trackChanges: plan?.inspection.trackChanges,
      files: plan?.files.map(f => ({ path: f.doc.path, added: f.added, removed: f.removed, mark: st.marks?.[`file:${f.doc.path}`], changed: changed.has(`file:${f.doc.path}`) || changed.has(`remote:${f.doc.path}`),
        ...f.create && { note: `New on Overleaf${f.create.folders.length ? ` · creates folder ${f.create.folders.join(', ')}` : ''}${plan.inspection.trackChanges ? ' · written as plain text, not as suggestions, as an Overleaf upload' : ''}` } })) ?? [],
      pictures: plan?.pictures?.map(f => ({ path: f.path, summary: outgoingSummary(f), sends: sendsPicture(f), created: f.kind === 'create', note: f.note, changed: changed.has(`picture:${f.path}`) })),
      comments: plan?.comments ?? [], places: places(plan?.comments), marks: Object.fromEntries(Object.entries(st.marks ?? {}).filter(([key]) => key.startsWith('comment:')).map(([key, reason]) => [key.slice(8), reason])), changed: keyed(st.changed, 'comment:'),
      incoming: plan?.incoming && (plan.incoming.files.length || plan.incoming.comments.length) ? { files: plan.incoming.files.map(f => ({ path: f.path, added: f.added, removed: f.removed, changed: changed.has(`incoming:${f.path}`) })), comments: plan.incoming.comments, places: places(plan.incoming.comments), changed: keyed(st.changed, 'incoming-comment:') } : undefined,
      blocked: st.blocked && { way: st.blocked.way, message: st.blocked.message, draftId: st.blocked.draftId }, unsaved: unsaved.length ? unsaved : undefined,
      check: { mode: config().get<string>('sendCheck', 'full') === 'fast' ? 'fast' : 'full', live: !!live },
      asOf: !live && checkedAt ? new Date(checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : undefined };
  }
  function undoView(): UndoView | undefined {
    const u = undoing; if (!u || !inspection || !service) return;
    const changed = new Set(u.changed), unsaved = unsavedNames();
    // Rejecting your own suggestions is how a tracked edit is taken back: the file row stands for them.
    const comments = u.plan?.plan.comments.filter(change => !change.suggestion) ?? [];
    return { record: u.record, time: u.time, busy: standingBusy || sending, ...sendWait(u), notice: u.notice, selectedPath: selectedDiff,
      files: u.plan?.files.map(f => ({ path: f.path, added: f.added, removed: f.removed, note: f.note, mark: f.mark, changed: changed.has(`file:${f.path}`) || changed.has(`remote:${f.path}`) })) ?? [],
      pictures: u.plan?.plan.pictures?.map(f => ({ path: f.path, summary: outgoingSummary(f), sends: sendsPicture(f), note: f.note, changed: changed.has(`picture:${f.path}`) })),
      comments, changed: keyed(u.changed, 'comment:'), stays: u.plan?.stays.map(row => ({ label: row.label, path: row.path, reason: row.reason })) ?? [],
      blocked: u.blocked && { way: u.blocked.way, message: u.blocked.message }, unsaved: unsaved.length ? unsaved : undefined };
  }
  // Coalesce renders within a tick and skip unchanged HTML, so hover, selection
  // and an open dropdown survive unrelated editor events. A hidden webview
  // drops messages and reloads its initial HTML, then asks for a fresh render.
  const posted = new WeakMap<vscode.Webview, string>();
  let renderQueued = false;
  // In the editor test: the status block of every render, including ones no view shows.
  const renderLog: { state: string; connected: boolean }[] | undefined = context.extensionMode === vscode.ExtensionMode.Test ? [] : undefined;
  function post(target: vscode.WebviewView | vscode.WebviewPanel | undefined, surface: Surface, value: ProjectView) {
    if (!target) return;
    if (!target.visible) { posted.delete(target.webview); return; }
    const html = projectContent(value, surface);
    if (posted.get(target.webview) === html) return;
    posted.set(target.webview, html); void target.webview.postMessage({ type: 'render', html });
  }
  function renderPanel() {
    if (renderQueued) return;
    renderQueued = true;
    queueMicrotask(() => {
      renderQueued = false;
      if (renderLog) try { const value = view(); renderLog.push({ state: value.state, connected: !!value.connected }); } catch { /* logged below when shown */ }
      if (!panel && !overview) return;
      try { const value = view(); post(overview, 'sidebar', value); post(panel, 'panel', value); }
      catch (error) { host.output.appendLine(`Project view: ${safeError(error)}`); }
    });
  }
  // Why a pressed button was disabled, from the state the host has when the press arrives.
  function disabledResult(command: string): ActionResult {
    if (host.isBusy()) return { outcome: 'busy', operation: host.operation() ?? 'another operation' };
    if (SEND_COMMANDS.has(command)) {
      const undo = command === 'sendUndo', shown = undo ? undoing : standing;
      const gate = sendGate({ shown, refreshing: standingBusy, refreshCause: refreshCause ?? pendingCause, sending, now: Date.now() });
      if (gate) return gate;
      if (shown?.blocked) return { outcome: 'blocked', error: shown.blocked.message };
      if (!(undo ? rowCount(undoing?.plan?.plan) : rowCount(standing?.plan))) return { outcome: 'nothing-to-send' };
    }
    return { outcome: 'disabled' };
  }
  const sendLabel = (command: string) => command === 'sendUndo' ? 'Send undo' : 'Send';
  const notePress = (text: string | undefined) => { if (pressNote !== text) { pressNote = text; renderPanel(); } };
  const presses = new PressTracker({
    pressed(press) { host.presses.pressed(press); if (SEND_COMMANDS.has(press.command) && press.detail <= 1) notePress(undefined); },
    ended(press, result) { host.presses.ended(press, result); const text = SEND_COMMANDS.has(press.command) ? pressNotice(result, sendLabel(press.command)) : undefined; if (text) notePress(text); },
    disabledResult,
  });
  const localSeq = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
  // The latest view of each surface takes messages; the editor test posts through it too.
  const viewListeners = new Map<Surface, (message: any) => void>();
  function wire(webview: vscode.Webview, surface: Surface) {
    webview.options = { enableScripts: true, localResourceRoots: [] }; webview.html = projectPanel(view(), surface);
    const handle = (message: any) => {
      if (message?.ready === true) { posted.delete(webview); renderPanel(); return; }
      // The press record: pointerdown on a button, its release, and extra clicks of a double click.
      const seq = localSeq(message?.seq);
      if (message?.type === 'press' && seq && typeof message.command === 'string' && /^[A-Za-z]{1,40}$/.test(message.command)) {
        presses.press(surface, { seq, command: message.command, disabled: message.disabled === true, detail: localSeq(message.detail) ?? 1 }); return;
      }
      if (message?.type === 'release' && seq) { presses.release(surface, seq, message.lost === true); return; }
      if (message?.type === 'click-extra' && seq) { presses.extra(surface, seq); return; }
      const tag = { turnleafPress: true, surface, ...(() => { const press = presses.command(surface, localSeq(message?.press)); return press === undefined ? {} : { seq: press }; })() };
      if (typeof message?.id === 'string' && rows.some(r => r.thread.id === message.id)) void vscode.commands.executeCommand('turnleaf.openThread', message.id, tag);
      if (['signIn', 'signInWithCookie', 'signOut', 'linkProject', 'openWalkthrough', 'configureFiles', 'enableWrites', 'refreshComments', 'pull', 'push', 'send', 'saveAll', 'openOutgoingDiff', 'undoSend', 'sendUndo', 'cancelUndo', 'sendReviewed', 'applyReviewed', 'applyAndReview', 'openPreviewDiff', 'cancelPreview', 'resolveConflict', 'useResolution', 'useRemoteVersion', 'keepLocalVersion', 'reviewDetails', 'recoverLocalApply', 'checkRemote', 'setCheckInterval', 'setSendCheck', 'toggleComments', 'toggleHighlights', 'toggleOutlineMarkers', 'showReviewPanel', 'openOverleaf', 'showSyncHistory', 'openReviewFiles', 'toggleReviewFiles', 'toggleReviewFilter', 'setCommentMarkers', 'setDeletionDisplay', 'editDraft', 'discardDraft', 'reattachDraft', 'newComment', 'reply', 'resolve', 'reopen', 'openThread', 'openSuggestion', 'acceptChange', 'rejectChange', 'acceptAllChanges', 'rejectAllChanges', 'decideAuthorChanges', 'editMessage', 'deleteMessage'].includes(message?.command)) void vscode.commands.executeCommand(`turnleaf.${message.command}`, { path: message.path, preview: message.preview, value: message.value, ...typeof message.text === 'string' && { text: message.text }, ...typeof message.message === 'string' && { message: message.message } }, tag);
    };
    viewListeners.set(surface, handle);
    context.subscriptions.push(webview.onDidReceiveMessage(handle));
  }
  async function showOverview() {
    // The overview opens even when the cached review cannot be shown.
    if (!service && restorable()) await restoreCached().catch(error => host.output.appendLine(`Cached review unavailable: ${safeError(error)}`));
    await vscode.commands.executeCommand('turnleaf.project.focus'); renderPanel();
  }
  const register = (id: string, fn: (...args: any[]) => Promise<unknown>, mode?: CommandMode) => host.register(`turnleaf.${id}`, fn, mode);
  register('openWalkthrough', async () => { await vscode.commands.executeCommand('workbench.action.openWalkthrough', `${context.extension.id}#start`, false); }, 'quiet');
  register('openReviewFiles', async () => {
    const s = await setup();
    if (!await saveTracked(s, 'Save & open review files')) return;
    const files = new LocalReviewFiles(s.state);
    if (!reviewFilesOn()) await config().update('localReviewFiles', true, vscode.ConfigurationTarget.WorkspaceFolder);
    await syncReviewFiles(s); await draw(); await status();
    if (reviewFilesError) throw new SyncError(reviewFilesError, 'review-files');
    await vscode.window.showTextDocument(vscode.Uri.file(await files.path()), { preview: false });
  });
  register('refreshComments', refresh, 'window'); register('pull', pull);
  // The former review commands open the summary, where Send is.
  const revealSummary = async () => { await setup(); if (!inspection) await restoreCached(); await status(); await showOverview(); };
  register('push', revealSummary, 'quiet'); register('pushDryRun', revealSummary, 'quiet'); register('openThread', openThread, 'quiet');
  register('openSuggestion', async arg => {
    const s = await setup(), pos = Number(arg?.value);
    if (typeof arg?.path !== 'string' || !s.paths.includes(arg.path) || !Number.isSafeInteger(pos) || pos < 0) return;
    const uri = vscode.Uri.joinPath(vscode.Uri.file(s.root), arg.path), visible = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === uri.toString());
    const editor = await vscode.window.showTextDocument(uri, { viewColumn: visible?.viewColumn ?? lastSource?.viewColumn ?? vscode.ViewColumn.Active });
    const point = editor.document.positionAt(pos); editor.selection = new vscode.Selection(point, point); editor.revealRange(new vscode.Range(point, point), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }, 'quiet');
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('turnleaf.project', { resolveWebviewView(value) { overview = value; wire(value.webview, 'sidebar'); value.onDidDispose(() => { overview = undefined; }, undefined, context.subscriptions); } }));
  register('showOverview', showOverview, 'quiet'); register('send', send); register('sendReviewed', send); register('applyReviewed', applyReviewed); register('applyAndReview', applyReviewed); register('openPreviewDiff', openPreviewDiff, 'quiet');
  register('openOutgoingDiff', openOutgoingDiff, 'quiet'); register('undoSend', undoSend); register('sendUndo', sendUndo);
  register('cancelUndo', async () => { undoing = undefined; if (selectedDiff?.startsWith('undo:')) selectedDiff = undefined; paintStatus(); }, 'quiet');
  register('saveAll', async () => { const s = await setup(); for (const doc of dirtyTracked(s)) if (!await doc.save()) throw new SyncError(`Could not save ${doc.fileName}.`, 'stale'); scheduleStanding(true, { label: 'files saved', at: Date.now() }); }, 'quiet');
  register('cancelPreview', async () => { prepared = undefined; resolutionPaths.clear(); note = 'Preview closed. No further file changes applied.'; paintStatus(); }, 'quiet');
  register('resolveConflict', arg => resolveConflict(arg, false)); register('useResolution', arg => resolveConflict(arg, true));
  // Without a shared baseline the extension cannot merge; the user picks a side.
  async function chooseVersion(arg: { path?: string; preview?: string; value?: string }, side: 'remote' | 'local') {
    const p = prepared;
    if (!p || p.stale || p.complete || arg?.preview !== p.id) throw new SyncError('Prepare a fresh Get latest preview first.', 'stale');
    if (arg.value === 'picture' && arg.path) { p.plan = new ReviewWorkflow(p.source).choosePicture(p.plan, arg.path, side); p.created = Date.now(); paintStatus(); return; }
    const file = p.plan.files.find(f => f.path === arg.path && f.conflict && f.firstSync);
    if (!file) throw new SyncError('Select a file that has not been synchronized before.', 'conflict');
    p.plan = new ReviewWorkflow(p.source).resolve(p.plan, file.path, side === 'remote' ? file.remote : file.before); p.created = Date.now();
    paintStatus(); await openPreviewDiff({ path: file.path, preview: p.id });
  }
  register('useRemoteVersion', arg => chooseVersion(arg, 'remote')); register('keepLocalVersion', arg => chooseVersion(arg, 'local'));
  register('checkRemote', checkRemote, 'window');
  register('toggleReviewFilter', async arg => {
    if (!(arg?.value in reviewFilterDefault)) return;
    const kind = arg.value as keyof ReviewFilter;
    reviewFilter = { ...reviewFilter, [kind]: !reviewFilter[kind] }; await context.workspaceState.update('turnleaf.reviewFilter', reviewFilter);
    if (revealedThread) {
      const row = rows.find(r => r.thread.id === revealedThread), pending = projectData.pending.some(draft => draft.threadId === revealedThread);
      if (!row || !matchesThreadFilter(row.thread.resolved, pending, reviewFilter)) revealedThread = undefined;
    }
    await draw(); renderPanel();
  }, 'quiet');
  register('setCommentMarkers', async arg => {
    if (!['belowParagraph', 'commentedLine'].includes(arg?.value)) return;
    const scope = await host.scope();
    await vscode.workspace.getConfiguration('turnleaf', scope.folder.uri).update('commentMarkers', arg.value, vscode.ConfigurationTarget.WorkspaceFolder);
  }, 'quiet');
  register('setDeletionDisplay', async arg => {
    const choices: Array<vscode.QuickPickItem & { value: DeletionDisplay }> = [
      { value: 'inline', label: 'Struck-through text', detail: 'The deleted text, struck through. Word wrap does not count it, so a wrapped row can run past the editor\'s edge.' },
      { value: 'marker', label: 'Marker', detail: 'Marks the deletion point and adds no text; the hover shows the deleted text. For word wrap.' },
      { value: 'inlayHint', label: 'Inlay hint', detail: 'The deleted text as an inlay hint, which word wrap counts. Uses your inlay hint colors; with inlay hints off, the marker is shown.' },
    ];
    const current = deletionDisplaySetting();
    const value = deletionDisplays.includes(arg?.value) ? arg.value as DeletionDisplay : (await vscode.window.showQuickPick(choices.map(c => ({ ...c, description: c.value === current ? 'current' : undefined })), { title: 'Show suggested deletions as' }))?.value;
    if (!value) return;
    const scope = await host.scope();
    await vscode.workspace.getConfiguration('turnleaf', scope.folder.uri).update('deletionDisplay', value, vscode.ConfigurationTarget.WorkspaceFolder);
  }, 'quiet');
  register('toggleReviewFiles', async () => {
    const scope = await host.scope();
    await vscode.workspace.getConfiguration('turnleaf', scope.folder.uri).update('localReviewFiles', !reviewFilesOn(), vscode.ConfigurationTarget.WorkspaceFolder);
  });
  register('toggleComments', async arg => { allComments = arg?.value === 'all' ? true : arg?.value === 'current' ? false : !allComments; renderPanel(); }, 'quiet');
  // Off hides every inline review highlight (comments and suggestions). Open comment
  // windows are closed too, since the editor highlights an open thread's text itself.
  register('toggleHighlights', async () => {
    highlightComments = !highlightComments; await context.workspaceState.update('turnleaf.highlightComments', highlightComments);
    if (!highlightComments) for (const thread of threads) thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    vscode.window.setStatusBarMessage(highlightComments ? 'Review highlights on' : 'Review highlights off', 3000);
    await draw(); renderPanel();
  }, 'quiet');
  register('toggleOutlineMarkers', async arg => { await markers.toggle(arg?.value === 'global' || arg?.value === 'workspace' ? arg.value : undefined); renderPanel(); }, 'quiet');
  register('setCheckInterval', async arg => {
    if (!['live', 0, 10, 30, 60].includes(arg?.value)) return;
    const scope = await host.scope(), settings = vscode.workspace.getConfiguration('turnleaf', scope.folder.uri);
    await settings.update('liveUpdates', arg.value === 'live', vscode.ConfigurationTarget.WorkspaceFolder);
    if (arg.value !== 'live') await settings.update('remoteCheckInterval', arg.value, vscode.ConfigurationTarget.WorkspaceFolder);
    scheduleCheck(); renderPanel();
  });
  // The sidebar's Full/Fast switch writes the same setting, for this folder only.
  register('setSendCheck', async arg => {
    const value = arg?.value ?? (await vscode.window.showQuickPick([{ label: 'Full', value: 'full', detail: 'Re-reads every selected file before and after sending.' }, { label: 'Fast', value: 'fast', detail: 'Re-reads only files Overleaf reported as edited over the live connection, and the files sent.' }], { title: 'Check before sending' }))?.value;
    if (value !== 'full' && value !== 'fast') return;
    const scope = await host.scope();
    await vscode.workspace.getConfiguration('turnleaf', scope.folder.uri).update('sendCheck', value, vscode.ConfigurationTarget.WorkspaceFolder);
    renderPanel();
  });
  register('enableWrites', async () => {
    const scope = await host.scope();
    if (!scope.projectId) throw new SyncError('Choose a project before enabling sending.', 'configuration');
    await vscode.workspace.getConfiguration('turnleaf', scope.folder.uri).update('allowWrites', !writes(), vscode.ConfigurationTarget.WorkspaceFolder);
    await draw(); renderPanel();
  });
  register('openOverleaf', async () => { const scope = await host.scope(); await vscode.env.openExternal(vscode.Uri.parse(scope.baseUrl + (scope.projectId ? '/project/' + encodeURIComponent(scope.projectId) : '/project'))); });
  let historyPanel: vscode.WebviewPanel | undefined;
  register('showSyncHistory', async () => {
    const s = await setup();
    if (!historyPanel) {
      historyPanel = vscode.window.createWebviewPanel('turnleafHistory', 'Turnleaf sync history', vscode.ViewColumn.Beside, { enableScripts: true, localResourceRoots: [] });
      historyPanel.onDidDispose(() => { historyPanel = undefined; }, undefined, context.subscriptions);
      context.subscriptions.push(historyPanel.webview.onDidReceiveMessage(message => {
        const tag = { turnleafPress: true, surface: 'history' };
        if (message?.refresh) void vscode.commands.executeCommand('turnleaf.showSyncHistory', tag);
        else if (message?.clear) void vscode.commands.executeCommand('turnleaf.clearHistory', tag);
        else if (typeof message?.undo === 'string') void vscode.commands.executeCommand('turnleaf.undoSend', { value: message.undo }, tag);
        else if (typeof message?.entry === 'string' && typeof message?.path === 'string') void vscode.commands.executeCommand('turnleaf.historyDiff', message, tag);
      }));
    }
    await refreshHistory(); historyPanel.reveal(vscode.ViewColumn.Beside);
  }, 'quiet');
  // Redraws an open Sync history after a send or an undo, without bringing it forward.
  async function refreshHistory() {
    const s = service; if (!s || !historyPanel) return;
    try { historyPanel.webview.html = historyPage(await s.state.history(), { bytes: (await s.state.historyUsage()).bytes, limit: s.state.retention().records, days: s.state.retention().days }); }
    catch (error) { host.output.appendLine(`Sync history: ${safeError(error)}`); }
  }
  register('clearHistory', async () => {
    const s = await setup();
    if (await vscode.window.showWarningMessage('Remove older sync history?', { modal: true, detail: 'Keeps the 10 most recent records and any record an interrupted sync still needs. File copies used only by removed records are deleted.' }, 'Remove older history') !== 'Remove older history') return;
    const removed = await s.state.pruneHistory(10, 0);
    host.output.appendLine(`Sync history: removed ${removed} older ${removed === 1 ? 'record' : 'records'}.`);
    if (historyPanel) await vscode.commands.executeCommand('turnleaf.showSyncHistory');
  });
  register('historyDiff', async arg => {
    const s = await setup(), [entry] = await s.state.history(arg.entry);
    const file = entry?.files.find(file => file.path === arg.path); if (!file) throw new SyncError('This history diff is unavailable.', 'cache');
    const before = host.text(`History-before/${file.path}`, file.before), after = host.text(`History-after/${file.path}`, file.after);
    previewColors.add(before, after, file.before, file.after);
    await vscode.commands.executeCommand('vscode.diff', before, after, `${file.path} · ${entry.direction} · ${new Date(entry.time).toLocaleString()}`);
    previewColors.paint();
  }, 'quiet');
  context.subscriptions.push({ dispose() { historyPanel?.dispose(); } });
  register('reviewDetails', async () => {
    const p = prepared && !prepared.complete ? prepared : undefined, u = undoing?.plan, plan = standing?.plan;
    const report = p ? (p.stale ? `OUT OF DATE: ${p.stale}\n\n` : '') + ['# Changes to local files', '', 'The right side of each diff is the exact proposed merged content. Applying preserves non-overlapping local changes and keeps a recovery checkpoint.', ...p.plan.files.map(f => `- ${f.path}: +${f.added} −${f.removed}${f.conflict ? ' · conflict: resolve before applying' : ''}`), ...p.plan.comments.map(c => `\n## ${c.label} · ${c.path}\n\nBefore:\n${threadText(c.before)}\n\nAfter:\n${threadText(c.after)}`)].join('\n')
      : u ? pushReport(u.plan) : plan && rowCount(plan) ? pushReport(plan) : lastReport;
    if (report) await vscode.window.showTextDocument(host.text('review-details.md', report));
  }, 'quiet');
  register('recoverLocalApply', async () => {
    const s = await setup(); if (!await saveTracked(s, 'Save before recovery')) return;
    const journal = (await s.state.cache()).localApply; if (!journal) return;
    if (await vscode.window.showWarningMessage('Restore the selected files to their state before the interrupted apply?', { modal: true, detail: `Checkpoint: ${journal.checkpoint}. Files edited since the interruption will be left untouched and reported for manual recovery.` }, 'Restore checkpoint') !== 'Restore checkpoint') return;
    applying = true;
    try { await new ReviewWorkflow(s).recover(() => service === s && !dirtyTracked(s).length); prepared = undefined; diskTexts.clear(); await refresh(); scheduleStanding(true, { label: 'local apply recovered', at: Date.now() }); }
    finally { applying = false; cache = await s.state.cache(); paintStatus(); }
  });
  register('verifySnapshotLink', pull);
  register('configureFiles', async (arg?: { testPaths?: unknown }) => {
    // The editor test chooses files without the quick pick, through the same steps.
    if (context.extensionMode === vscode.ExtensionMode.Test && Array.isArray(arg?.testPaths)) return applySelection(await host.scope(), validateTrackedFiles(arg.testPaths));
    await chooseFiles();
  });
  /**
   * The quick pick of Choose files. With no files chosen yet (a newly linked
   * project), every source file on Overleaf starts ticked, the main document first.
   */
  async function chooseFiles() {
    const scope = await host.scope();
    const valid = (path: string) => { try { validateTrackedFiles([path]); return true; } catch { return false; } };
    const listed = await (await host.reader(scope)).listSourceFiles(scope.projectId), rootDoc = listed.rootDoc && valid(listed.rootDoc) ? listed.rootDoc : undefined;
    const choices = listed.paths.filter(valid).sort((a, b) => Number(b === rootDoc) - Number(a === rootDoc)), fresh = !scope.trackedFiles.length;
    // Local text files that Overleaf does not have yet: Send creates them there.
    // Hidden folders (.turnleaf, .git) and node_modules are left out; files.exclude applies.
    const local = (await vscode.workspace.findFiles(new vscode.RelativePattern(scope.folder, '**/*.{tex,bib,sty,cls}'), undefined, 2000))
      .map(uri => relative(scope.folder.uri.fsPath, uri.fsPath).replace(/\\/g, '/'))
      .filter(path => valid(path) && !choices.includes(path) && !path.split('/').some(part => part.startsWith('.') || part === 'node_modules')).sort();
    const gone = scope.trackedFiles.filter(path => !choices.includes(path) && !local.includes(path));
    // Local pictures that Overleaf does not have and that were never synchronized: Send creates the picked ones.
    const pictureStore = new ProjectStore(scope.folder.uri.fsPath, scope.baseUrl, scope.projectId, scope.trackedFiles);
    const pictures = config().get<boolean>('syncPictures', true) ? await pictureStore.pictures() : undefined;
    let localPictures: string[] = [];
    if (pictures) {
      const tree = await (await host.reader(scope)).projectTree(scope.projectId);
      localPictures = (await vscode.workspace.findFiles(new vscode.RelativePattern(scope.folder, '**/*.{png,jpg,jpeg,pdf,PNG,JPG,JPEG,PDF}'), undefined, 2000))
        .map(uri => relative(scope.folder.uri.fsPath, uri.fsPath).replace(/\\/g, '/'))
        .filter(path => isPicture(path) && !tree.fileRefs?.[path] && !tree.files.includes(path) && !tree.docs?.[path] && !pictures.baseline[path] && !path.split('/').some(part => part.startsWith('.') || part === 'node_modules')).sort();
    }
    const items: (vscode.QuickPickItem & { path?: string; picture?: boolean })[] = [
      ...choices.map(path => ({ label: path, path, ...path === rootDoc && { description: 'main document' }, picked: fresh || scope.trackedFiles.includes(path) })),
      ...local.length ? [{ label: 'Only in the local folder', kind: vscode.QuickPickItemKind.Separator }, ...local.map(path => ({ label: path, path, description: 'new on Overleaf: created at Send', picked: scope.trackedFiles.includes(path) }))] : [],
      // These cannot be synchronized, so they start unticked: OK removes them from the selection.
      ...gone.length ? [{ label: 'Neither local nor on Overleaf', kind: vscode.QuickPickItemKind.Separator }, ...gone.map(path => ({ label: path, path, description: 'missing: OK removes it', picked: false }))] : [],
      ...localPictures.length ? [{ label: 'Pictures only in the local folder', kind: vscode.QuickPickItemKind.Separator }, ...localPictures.map(path => ({ label: path, path, picture: true, description: 'new on Overleaf: uploaded at Send', picked: !!pictures?.added?.includes(path) }))] : [],
    ];
    const selected = await vscode.window.showQuickPick(items, { title: 'Choose source files to synchronize', canPickMany: true, placeHolder: 'Selected files receive comments and participate in previews. Local-only files are created on Overleaf by Send.' });
    if (!selected) return;
    const paths = selected.flatMap(item => item.path && !item.picture ? [item.path] : []);
    if (!paths.length) throw new SyncError('Choose at least one source file (.tex, .bib, .sty or .cls).', 'configuration');
    let picturesChanged = false;
    if (pictures) {
      const picked = selected.filter(item => item.picture).map(item => item.path!);
      const added = [...new Set([...(pictures.added ?? []).filter(path => !localPictures.includes(path)), ...picked])].sort();
      if (fingerprint(added) !== fingerprint(pictures.added ?? [])) { await pictureStore.setPictures({ ...pictures, added }); picturesChanged = true; }
    }
    await applySelection(scope, validateTrackedFiles(paths), picturesChanged);
  }
  // picturesChanged: the pictures added in Choose files changed, so the summary is planned again.
  async function applySelection(scope: WorkspaceScope, paths: string[], picturesChanged = false) {
    const settings = vscode.workspace.getConfiguration('turnleaf', scope.folder.uri);
    const changed = [...paths].sort().join('\0') !== [...scope.trackedFiles].sort().join('\0'), connected = session === 'valid';
    if (changed) {
      // Adding files keeps the sync state of the current selection.
      if (await carrySelection(scope.folder.uri.fsPath, scope.baseUrl, scope.projectId, scope.trackedFiles, paths) === 'copied') host.output.appendLine(`File selection grew to ${paths.length} files; the sync state of the previous selection was kept.`);
      // The settings change rebuilds the review from the cache (clear()). The sign-in is
      // unchanged, so until the first read of the new selection returns, the status says
      // "Checking Overleaf…" instead of stale cached comments and a lost connection.
      reselecting = connected;
      try { await settings.update('trackedFiles', paths, vscode.ConfigurationTarget.WorkspaceFolder); }
      finally { reselecting = false; }
      if (connected) { session = 'valid'; checking = true; }
    } else if (service && !picturesChanged) { renderPanel(); return; } // Unchanged: the review stays as it is, not cached.
    const s = await restoreCached(); renderPanel();
    if (!checking) return;
    try { await checkRemote(); }
    catch (error) {
      if (error instanceof SessionExpiredError || error instanceof Error && error.cause instanceof SessionExpiredError) throw error;
      if (!(error instanceof SyncError && error.code === 'cancelled')) host.output.appendLine(`Remote check after the file selection changed: ${safeError(error)}`);
    } finally { if (service === s) { checking = false; paintStatus(); } }
  }
  register('markReconciled', pull);
  register('filterThreadsByAuthor', async () => { await ensure(); const names = [...new Set(rows.flatMap(r => r.thread.messages.map(m => m.author)))].sort(); const choice = await vscode.window.showQuickPick([{ label: 'All authors', value: undefined as string | undefined }, ...names.map(n => ({ label: n, value: n }))]); if (choice) { author = choice.value; await draw(); } }, 'quiet');
  register('exportReviewLog', async () => { await ensure(); await draw(); const path = await workspacePath(service!.root, config().get<string>('reviewLogPath', 'docs/overleaf_review_log.md')); if (service!.paths.includes(relative(service!.root, path).replace(/\\/g, '/'))) throw new SyncError('The review log cannot overwrite a tracked source file.', 'configuration'); await vscode.workspace.fs.createDirectory(vscode.Uri.file(dirname(path))); await writeFile(path, renderReviewLog(inspection!, rows, reviews, (await service!.state.read()).revision)); await vscode.window.showTextDocument(vscode.Uri.file(path)); });
  for (const kind of ['addressed', 'declined', 'open'] as const) register(kind === 'open' ? 'markOpen' : kind === 'addressed' ? 'markAddressed' : 'markDeclined', async arg => {
    const row = await pick(arg); if (!row) return;
    const reason = kind === 'declined' ? await vscode.window.showInputBox({ title: 'Reason for declining this comment', validateInput: v => v.trim() ? undefined : 'Enter a reason.' }) : undefined;
    if (kind === 'declined' && !reason) return;
    await service!.state.setReview(row.thread.id, { status: kind, sha: kind === 'addressed' ? (await service!.state.read()).revision : undefined, reason, updated: new Date().toISOString() }); reviews = await service!.state.reviews(); await draw();
  });
  function findComment(arg: RemoteComment | { comment: RemoteComment }): { comment: RemoteComment; thread: vscode.CommentThread } {
    const requested = 'comment' in arg ? arg.comment : arg;
    const thread = threads.find(t => ids.get(t) === requested.threadId);
    const comment = thread?.comments.find(c => (c as RemoteComment).messageId === requested.messageId) as RemoteComment | undefined;
    if (!thread || !comment?.messageId) throw new SyncError('Refresh this comment before editing.', 'configuration');
    return { comment, thread };
  }
  register('editComment', async arg => { const { comment, thread } = findComment(arg); comment.mode = vscode.CommentMode.Editing; thread.comments = [...thread.comments]; }, 'quiet');
  register('cancelCommentEdit', async arg => { const { comment, thread } = findComment(arg); comment.body = comment.original; comment.mode = vscode.CommentMode.Preview; thread.comments = [...thread.comments]; }, 'quiet');
  async function reloadDrafts(message = 'Comment draft saved locally, listed as going out.', cause = 'comment change queued') {
    const s = service!; projectData = await s.state.read(); inspection = projectedInspection(projectData);
    computed.clear(); diffs.clear(); invalidateReview('Pending comments changed. Review again.'); await syncReviewFiles(s); await draw(); await status(message, { label: cause, at: Date.now() });
  }
  // Accept or reject a suggestion on the next Send; choosing the same again undoes it.
  async function decide(kind: 'acceptChange' | 'rejectChange', arg?: { path?: string; value?: string }) {
    const s = await setup(), data = await s.state.read();
    const doc = inspection?.docs.find(doc => doc.path === arg?.path), suggestion = doc?.changes.find(change => change.id === arg?.value);
    if (!doc || !suggestion || !s.paths.includes(doc.path)) throw new SyncError('This suggestion changed. Refresh, then decide again.', 'stale');
    const change = suggestionRef(suggestion), existing = data.pending.find(draft => isDecision(draft) && draft.docId === doc.docId && sameSuggestion(draft.change!, change));
    if (existing?.uncertain) throw new SyncError('Inspect the uncertain result in Sync history before changing this decision.', 'recovery');
    if (existing?.kind === kind) { await s.state.discard(existing.id); await reloadDrafts('Suggestion decision undone.', 'suggestion decision undone'); return; }
    await s.state.queue({ id: existing?.id ?? randomUUID(), kind, path: doc.path, docId: doc.docId, threadId: '', change, created: new Date().toISOString() });
    await reloadDrafts(`${kind === 'acceptChange' ? 'Accept' : 'Reject'} saved locally, listed as going out.`, 'suggestion decision queued');
  }
  register('acceptChange', arg => decide('acceptChange', arg)); register('rejectChange', arg => decide('rejectChange', arg));
  type DecisionKind = 'acceptChange' | 'rejectChange';
  const decisionVerb = (kind: DecisionKind) => kind === 'acceptChange' ? 'Accept' : 'Reject';
  const suggestionCount = (n: number) => `${n} suggestion${n === 1 ? '' : 's'}`;
  // Each suggestion with the decision already saved for it, if any.
  const savedDecisions = (data: ProjectData, doc: DocState, changes: Suggestion[]) => changes.map(suggestion => {
    const change = suggestionRef(suggestion);
    return { change, existing: data.pending.find(draft => isDecision(draft) && draft.docId === doc.docId && sameSuggestion(draft.change!, change)) };
  });
  // Several suggestions of one file at once; when all already have this decision, undo them all.
  async function decideMany(kind: DecisionKind, doc: DocState, changes: Suggestion[], what: string) {
    const s = await setup(), decisions = savedDecisions(await s.state.read(), doc, changes);
    if (decisions.some(d => d.existing?.uncertain)) throw new SyncError('Inspect the uncertain result in Sync history before changing these decisions.', 'recovery');
    const undo = decisions.every(d => d.existing?.kind === kind), verb = decisionVerb(kind);
    for (const { change, existing } of decisions) {
      if (undo) await s.state.discard(existing!.id);
      else if (existing?.kind !== kind) await s.state.queue({ id: existing?.id ?? randomUUID(), kind, path: doc.path, docId: doc.docId, threadId: '', change, created: new Date().toISOString() });
    }
    await reloadDrafts(undo ? `${verb} ${what} undone.` : `${verb} ${what} saved locally, listed as going out.`, undo ? 'suggestion decisions undone' : 'suggestion decisions queued');
  }
  // The linked source file being edited: the active editor, else the last one used.
  function sourceEditor(s: SyncService) {
    const active = vscode.window.activeTextEditor;
    return active?.document.uri.scheme === 'file' && s.paths.includes(relative(s.root, active.document.uri.fsPath).replace(/\\/g, '/')) ? active : lastSource;
  }
  // The file a command names, or the file being edited; it must have suggestions.
  function suggestionDoc(s: SyncService, path?: string) {
    const editor = path === undefined ? sourceEditor(s) : undefined;
    const target = path ?? (editor && relative(s.root, editor.document.uri.fsPath).replace(/\\/g, '/'));
    const doc = inspection?.docs.find(doc => doc.path === target);
    if (!doc || !s.paths.includes(doc.path) || !doc.changes.length) throw new SyncError(target ? 'This file has no suggestions to decide. Refresh, then try again.' : 'Open a linked source file with suggestions first.', 'stale');
    return doc;
  }
  // Every suggestion in one file.
  async function decideAll(kind: DecisionKind, arg?: { path?: string }) {
    const doc = suggestionDoc(await setup(), typeof arg?.path === 'string' ? arg.path : undefined);
    await decideMany(kind, doc, doc.changes, `all in ${doc.path}`);
  }
  register('acceptAllChanges', arg => decideAll('acceptChange', arg)); register('rejectAllChanges', arg => decideAll('rejectChange', arg));
  // The suggestions the editor's selections touch, as in Overleaf's review panel.
  async function decideInSelection(kind: DecisionKind) {
    const s = await setup(), editor = sourceEditor(s), ranges = editor?.selections.filter(selection => !selection.isEmpty) ?? [];
    if (!editor || !ranges.length) throw new SyncError('Select text with suggestions in a linked source file first.', 'configuration');
    const path = relative(s.root, editor.document.uri.fsPath).replace(/\\/g, '/'), rows = suggestionRows.filter(row => row.path === path);
    const ids = new Set(ranges.flatMap(range => suggestionsInRange(rows, editor.document.offsetAt(range.start), editor.document.offsetAt(range.end)).map(row => row.id)));
    const doc = inspection?.docs.find(doc => doc.path === path), changes = doc?.changes.filter(change => ids.has(change.id)) ?? [];
    if (!doc || !changes.length) throw new SyncError('The selection has no suggestions to decide. Select text that includes a suggestion.', 'configuration');
    await decideMany(kind, doc, changes, `${suggestionCount(changes.length)} in the selection in ${doc.path}`);
  }
  register('acceptSelectionChanges', () => decideInSelection('acceptChange')); register('rejectSelectionChanges', () => decideInSelection('rejectChange'));
  // One author's suggestions in one file. Without a decision, the list offers both.
  async function decideByAuthor(kind?: DecisionKind, arg?: { path?: string; value?: string }) {
    const s = await setup(), doc = suggestionDoc(s, typeof arg?.path === 'string' ? arg.path : undefined), data = await s.state.read();
    const authors = suggestionAuthors(doc.changes), shared = (name: string) => authors.filter(a => a.name === name).length > 1;
    let choice: { kind: DecisionKind; author: SuggestionAuthor<Suggestion> } | undefined;
    if (kind && typeof arg?.value === 'string') {
      const author = authors.find(a => a.key === arg.value);
      if (!author) throw new SyncError('This author has no suggestions in this file. Refresh, then try again.', 'stale');
      choice = { kind, author };
    } else {
      const items = authors.flatMap(author => (kind ? [kind] : ['acceptChange', 'rejectChange'] as const).map(k => {
        const done = savedDecisions(data, doc, author.suggestions).every(d => d.existing?.kind === k), verb = decisionVerb(k);
        return { label: `${done ? `Undo ${verb.toLowerCase()} of` : verb} ${suggestionCount(author.suggestions.length)} from ${author.name}`, description: shared(author.name) ? author.key : undefined, choice: { kind: k, author } };
      }));
      choice = (await vscode.window.showQuickPick(items, { title: `Decide suggestions by author in ${doc.path}`, placeHolder: 'Saved locally until you Send' }))?.choice;
    }
    if (!choice) return;
    await decideMany(choice.kind, doc, choice.author.suggestions, `${suggestionCount(choice.author.suggestions.length)} from ${choice.author.name} in ${doc.path}`);
  }
  register('acceptAuthorChanges', arg => decideByAuthor('acceptChange', arg)); register('rejectAuthorChanges', arg => decideByAuthor('rejectChange', arg));
  register('decideAuthorChanges', arg => decideByAuthor(undefined, arg));
  async function mutateComment(kind: 'reply' | 'resolve' | 'reopen' | 'editMessage' | 'deleteMessage' | 'deleteThread', arg?: any) {
    let native: RemoteComment | undefined;
    if (kind === 'editMessage' || kind === 'deleteMessage') native = findComment(arg).comment;
    const row = await pick(native?.threadId ?? arg?.thread ?? arg); if (!row) return;
    const s = service!, data = await s.state.read();
    let text: string | undefined;
    if (kind === 'reply') {
      text = typeof arg?.text === 'string' ? arg.text : await vscode.window.showInputBox({ title: 'Draft reply', prompt: 'Saved locally. Send publishes this reply.', validateInput: v => v.trim() ? undefined : 'Enter a reply.' });
      if (text === undefined) return;
    }
    if (kind === 'editMessage') { const supplied = arg?.comment ?? arg; text = typeof supplied.body === 'string' ? supplied.body : supplied.body?.value; }
    if (text !== undefined && (!text.trim() || text.length > 20_000)) throw new SyncError('Enter comment text between 1 and 20,000 characters.', 'configuration');
    const pendingMessage = native?.messageId?.startsWith('draft:') && data.pending.find(d => `draft:${d.id}` === native!.messageId);
    if (pendingMessage) {
      if (kind === 'deleteMessage') await s.state.discard(pendingMessage.id);
      else await s.state.queue({ ...pendingMessage, text });
    } else {
      const before = data.acknowledged?.threads[row.thread.id];
      const newThread = data.pending.find(d => d.kind === 'createThread' && d.threadId === row.thread.id);
      if (kind === 'deleteThread' && newThread) await s.state.discard(newThread.id);
      else {
        if (native && !before?.messages.some(m => m.id === native!.messageId && m.authorId && m.authorId === data.acknowledged?.userId)) throw new SyncError('Only your own messages can be edited or deleted.', 'read-only');
        if (!before && !newThread) throw new SyncError('Apply incoming comments before changing this thread.', 'stale');
        // Coalesce repeated edits of one message/state, while retaining distinct replies.
        const existing = data.pending.find(d => d.threadId === row.thread.id && (native ? d.messageId === native.messageId : ['resolve', 'reopen'].includes(kind) ? ['resolve', 'reopen'].includes(d.kind) : kind === 'deleteThread' && d.kind === kind));
        await s.state.queue({ id: existing?.id ?? randomUUID(), kind, path: row.path, docId: row.docId, threadId: row.thread.id, messageId: native?.messageId, text, before: structuredClone(before), created: existing?.created ?? new Date().toISOString() });
      }
    }
    if (native) { native.mode = vscode.CommentMode.Preview; }
    await reloadDrafts(undefined, `comment ${{ reply: 'reply', resolve: 'resolve', reopen: 'reopen', editMessage: 'edit', deleteMessage: 'message deletion', deleteThread: 'thread deletion' }[kind]} queued`);
  }
  async function commentSelection(s: SyncService) {
    const sourcePath = (editor: vscode.TextEditor) => relative(s.root, editor.document.uri.fsPath).replace(/\\/g, '/');
    const editor = sourceEditor(s);
    if (!editor) throw new SyncError('Select text in a linked source file first.', 'configuration');
    const path = sourcePath(editor);
    const doc = inspection?.docs.find(d => d.path === path);
    if (!doc || editor.selection.isEmpty) throw new SyncError('Select the source text to attach the new comment to.', 'configuration');
    if (!await saveTracked(s, 'Save & draft comment')) return;
    const from = editor.document.offsetAt(editor.selection.start), to = editor.document.offsetAt(editor.selection.end), source = editor.document.getText();
    if (to <= from) throw new SyncError('Select a non-empty source range after saving.', 'configuration');
    return { path, docId: doc.docId, anchor: { from, to, source } };
  }
  register('newComment', async arg => {
    await ensure(); const s = service!, selection = await commentSelection(s);
    if (!selection) return;
    const text = typeof arg?.text === 'string' ? arg.text : await vscode.window.showInputBox({ title: 'New Overleaf comment', prompt: 'This comment is saved locally until you Send.', validateInput: v => v.trim() ? undefined : 'Enter a comment.' });
    if (text === undefined) return;
    const threadId = randomUUID().replaceAll('-', '').slice(0, 24);
    await s.state.queue({ id: randomUUID(), kind: 'createThread', ...selection, threadId, text, created: new Date().toISOString() });
    await reloadDrafts(undefined, 'new comment queued'); await openThread(threadId);
  });
  register('reattachDraft', async arg => {
    await ensure(); const s = service!, data = await s.state.read();
    const drafts = data.pending.filter(draft => draft.kind === 'createThread');
    const draft = typeof arg?.value === 'string' ? drafts.find(draft => draft.id === arg.value) :
      (await vscode.window.showQuickPick(drafts.map(draft => ({ label: draft.text ?? 'New comment', description: draft.path, draft })), { title: 'Update pending comment selection' }))?.draft;
    if (!draft) return;
    if (draft.uncertain) throw new SyncError('Inspect the uncertain result in Sync history before changing this draft.', 'recovery');
    const selection = await commentSelection(s); if (!selection) return;
    if (selection.path !== draft.path || selection.docId !== draft.docId) throw new SyncError(`Select the new comment range in ${draft.path}.`, 'configuration');
    if (fingerprint((await s.state.read()).pending.find(item => item.id === draft.id)) !== fingerprint(draft)) throw new SyncError('This pending comment changed. Select it again.', 'stale');
    await s.state.queue({ ...draft, anchor: selection.anchor }); unplacedDrafts.delete(draft.id);
    await reloadDrafts(undefined, 'comment selection updated'); await openThread(draft.threadId);
  });
  register('discardDraft', async arg => {
    const s = await setup(), data = await s.state.read();
    const draft = data.pending.find(d => d.id === arg?.value); if (!draft) return;
    if (await vscode.window.showWarningMessage('Discard this local comment draft?', { modal: true, detail: draft.uncertain ? 'Its earlier send has an uncertain outcome. Discarding removes only the local draft; inspect the remote thread and Sync history first.' : 'The draft will be removed locally. Existing Overleaf comments stay unchanged.' }, 'Discard draft') !== 'Discard draft') return;
    await s.state.discard(draft.id); await reloadDrafts(undefined, 'comment draft discarded');
  });
  register('editDraft', async arg => {
    const s = await setup(), draft = (await s.state.read()).pending.find(d => d.id === arg?.value); if (!draft || draft.text === undefined) return;
    if (draft.uncertain) throw new SyncError('Inspect the uncertain result in Sync history, then discard this draft before making a new one.', 'recovery');
    const text = await vscode.window.showInputBox({ title: 'Edit pending comment', value: draft.text, validateInput: v => v.trim() ? undefined : 'Enter comment text.' });
    if (text === undefined) return;
    await s.state.queue({ ...draft, text, before: (await s.state.read()).acknowledged?.threads[draft.threadId] }); await reloadDrafts(undefined, 'comment draft edited');
  });
  for (const kind of ['reply', 'resolve', 'reopen', 'deleteThread'] as const) register(kind, arg => mutateComment(kind, arg));
  register('saveComment', arg => mutateComment('editMessage', arg));
  register('deleteComment', arg => mutateComment('deleteMessage', arg));
  // From a card: the same edit or delete as the comment window's pencil and trash.
  register('editMessage', async arg => {
    const { comment } = findComment({ threadId: arg?.value, messageId: arg?.message } as RemoteComment);
    const text = await vscode.window.showInputBox({ title: 'Edit your comment', prompt: 'Saved locally. Send publishes the edit.', value: comment.original, validateInput: v => v.trim() ? undefined : 'Enter comment text.' });
    if (text === undefined || text === comment.original) return;
    await mutateComment('editMessage', { ...comment, body: text });
  });
  register('deleteMessage', arg => mutateComment('deleteMessage', { threadId: arg?.value, messageId: arg?.message }));
  register('showReviewPanel', async () => {
    if (!service && restorable()) await restoreCached();
    followEditor(vscode.window.activeTextEditor);
    if (panel) { panel.reveal(vscode.ViewColumn.Beside); renderPanel(); return; }
    panel = vscode.window.createWebviewPanel('overleafReview', 'Turnleaf Project', vscode.ViewColumn.Beside, { enableScripts: true, localResourceRoots: [] });
    panel.onDidDispose(() => { panel = undefined; }, undefined, context.subscriptions);
    wire(panel.webview, 'panel');
    renderPanel();
  }, 'quiet');
  register('exportReviewPdf', async () => {
    await ensure(); await draw(); const selected = await vscode.window.showOpenDialog({ title: 'Choose the compiled PDF with a matching SyncTeX file', defaultUri: vscode.Uri.joinPath(vscode.Uri.file(service!.root), 'build'), filters: { PDF: ['pdf'] }, canSelectMany: false }); if (!selected?.[0]) return;
    const result = await annotatePdf(service!, selected[0].fsPath, rows, reviews, context.asAbsolutePath('dist/pdf.mjs'));
    host.output.appendLine(`Annotated ${result.annotated} threads in ${result.path}.${result.skipped.length ? ` Unmapped: ${result.skipped.join(', ')}` : ''}`);
    if (result.skipped.length) vscode.window.showWarningMessage(`${result.skipped.length} threads could not be mapped by SyncTeX. See Turnleaf output.`);
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(result.path));
  });
  function followEditor(editor: vscode.TextEditor | undefined) {
    const group = vscode.window.tabGroups.activeTabGroup, input = group.activeTab?.input;
    // Cursor can publish a new active tab before activeTextEditor changes (and
    // sometimes retains the previous split while the window is in the background).
    // The tab is authoritative; a diff/webview keeps the last source context.
    const source = input instanceof vscode.TabInputText
      ? vscode.window.visibleTextEditors.find(e => e.viewColumn === group.viewColumn && e.document.uri.toString() === input.uri.toString())
      : input ? undefined : editor;
    if (source?.document.uri.scheme === 'file' && service?.paths.includes(relative(service.root, source.document.uri.fsPath).replace(/\\/g, '/'))) lastSource = source;
    renderPanel();
  }
  const scheduleDraw = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => { void draw().catch(error => host.output.appendLine(safeError(error))); }, 80);
  };
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  const changedFile = (uri: vscode.Uri) => {
    if (!service || uri.scheme !== 'file') return;
    const s = service, path = relative(s.root, uri.fsPath).replace(/\\/g, '/');
    if (isReviewFile(s, uri)) { scheduleReviewFiles(s); return; }
    if (s.paths.includes(path)) {
      diskTexts.delete(path); scheduleDraw();
      const p = prepared, a = activeSend;
      if ((p && !p.complete || a) && !applying) void readSaved(s.root, s.paths, true).then(saved => { if (p && p === prepared && !sameSaved(saved, p.plan.saved ?? {}) || a && a === activeSend && !sameSaved(saved, a.saved)) invalidateReview('A selected file changed on disk.'); }).catch(() => invalidateReview('A selected source file is unavailable.'));
      scheduleStanding(true, { label: `${path} changed on disk`, at: Date.now() });
    }
    // A picture the summary may send, or the picture state itself.
    if (s.state.syncPictures() && (isPicture(path) && !path.startsWith('.turnleaf/') || /^\.turnleaf\/projects\/[0-9a-f]+\/pictures\.json$/.test(path))) scheduleStanding(true, { label: path.startsWith('.turnleaf/') ? 'picture selection changed' : `${path} changed on disk`, at: Date.now() });
    if (path === '.turnleaf/review-state.json') void s.state.reviews().then(value => { if (service === s) { reviews = value; scheduleDraw(); } }).catch(error => host.output.appendLine(safeError(error)));
  };
  context.subscriptions.push(controller, highlight, insertion, marker, deletionAfter, deletionBefore, deletionHintsChanged, previewColors, poller,
    vscode.languages.registerInlayHintsProvider({ scheme: 'file' }, { onDidChangeInlayHints: deletionHintsChanged.event, provideInlayHints: (doc, range) => (deletionHints.get(doc.uri.toString()) ?? []).filter(hint => range.contains(hint.position)) }), { dispose() { disposed = true; clear(); presses.dispose(); panel?.dispose(); } },
    watcher, watcher.onDidChange(changedFile), watcher.onDidCreate(changedFile), watcher.onDidDelete(changedFile),
    vscode.workspace.onDidChangeTextDocument(event => {
      if (service && isReviewFile(service, event.document.uri)) {
        if (event.document.isDirty) invalidateReview('A comment JSON buffer changed. Save and review again.');
        return;
      }
      if (!service || !inspection || event.document.uri.scheme !== 'file') return;
      const path = relative(service.root, event.document.uri.fsPath).replace(/\\/g, '/'), doc = inspection.docs.find(d => d.path === path), prior = diffs.get(path); if (!doc) return;
      if ((!applying || event.document.isDirty) && (event.contentChanges.length || event.document.isDirty)) invalidateReview('A selected editor buffer changed. Save and review again.');
      if (event.reason === vscode.TextDocumentChangeReason.Undo || event.reason === vscode.TextDocumentChangeReason.Redo) { diffs.delete(path); computed.delete(path); }
      else if (prior && event.contentChanges.length && event.contentChanges.every(c => c.rangeLength < prior.local.length && c.rangeLength < Math.max(100, prior.local.length / 2))) diffs.set(path, { local: event.document.getText(), diffs: composeEdits(doc.text, prior.diffs, event.contentChanges) }); else diffs.delete(path);
      scheduleDraw();
    }),
    vscode.window.onDidChangeActiveTextEditor(followEditor),
    // Saving a conflict's merged copy uses it; leftover markers are reported on the file row.
    vscode.workspace.onDidSaveTextDocument(document => {
      if (service && isReviewFile(service, document.uri)) { scheduleReviewFiles(service); return; }
      const saved = service && document.uri.scheme === 'file' ? relative(service.root, document.uri.fsPath).replace(/\\/g, '/') : undefined;
      if (saved && service!.paths.includes(saved)) scheduleStanding(true, { label: `${saved} saved`, at: Date.now() }); else renderPanel();
      const p = prepared, path = [...resolutionPaths].find(([, uri]) => uri.toString() === document.uri.toString())?.[0];
      if (!p || p.stale || p.complete || !path) return;
      void resolveConflict({ path, preview: p.id }, true).then(() => { conflictNotes.delete(path); renderPanel(); }, error => {
        const left = (document.getText().match(/^<{7}( |$)/gm) ?? []).length;
        conflictNotes.set(path, error instanceof SyncError && error.code === 'conflict' ? `${left || 'Some'} ${left === 1 ? 'conflict is' : 'conflicts are'} left in the merged copy. Resolve and save again.` : safeError(error)); renderPanel();
      });
    }),
    // Pause the live connection after five minutes in the background.
    vscode.window.onDidChangeWindowState(state => {
      if (state.focused) {
        if (idleTimer) clearTimeout(idleTimer); idleTimer = undefined;
        if (paused) { paused = false; poller.soon(300); }
      } else idleTimer ??= setTimeout(() => {
        idleTimer = undefined;
        if (vscode.window.state.focused || !live) return;
        paused = true; closeLive(); freshness = 'Live updates paused while the window is in the background'; paintStatus();
      }, 5 * 60_000);
    }),
    { dispose() { if (idleTimer) clearTimeout(idleTimer); if (liveTimer) clearTimeout(liveTimer); } },
    vscode.window.tabGroups.onDidChangeTabs(() => followEditor(vscode.window.activeTextEditor)),
    vscode.window.tabGroups.onDidChangeTabGroups(() => followEditor(vscode.window.activeTextEditor)),
    vscode.window.onDidChangeVisibleTextEditors(() => { followEditor(vscode.window.activeTextEditor); void draw().catch(e => host.output.appendLine(safeError(e))); }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('turnleaf.allowWrites')) { invalidateReview(writes() ? 'Sending was switched on.' : 'Sending was switched off.'); void draw(); paintStatus(); }
      if (e.affectsConfiguration('turnleaf.remoteCheckInterval')) { scheduleCheck(); renderPanel(); }
      if (e.affectsConfiguration('turnleaf.commentMarkers') || e.affectsConfiguration('editor.wordWrap') || e.affectsConfiguration('turnleaf.deletionDisplay') || e.affectsConfiguration('editor.inlayHints.enabled')) { void draw().catch(error => host.output.appendLine(safeError(error))); renderPanel(); }
      if (e.affectsConfiguration('turnleaf.localReviewFiles')) { if (service) scheduleReviewFiles(service); renderPanel(); }
      if (e.affectsConfiguration('turnleaf.sendCheck')) { renderPanel(); void confirmFastSend(); }
      if (e.affectsConfiguration('turnleaf.liveUpdates')) { closeLive(); scheduleCheck(); if (liveEnabled()) poller.soon(500); renderPanel(); }
      if (e.affectsConfiguration('workbench.productIconTheme')) renderPanel();
    }));


  return {
    clear, refresh, restoreCached, checkNow, chooseFiles,
    setSessionState(value: typeof session) { session = value; if (value === 'expired' || value === 'signedOut') { checking = false; invalidateReview('Sign in again before preparing a new review.'); void closeLive(); } scheduleCheck(); paintStatus(); },
    /** Closes the live connection, including one still being opened. */
    async disconnect() { await connecting?.catch(() => {}); await closeLive(); },
    operationChanged: renderPanel,
    /** Where this project's press record goes; none before a project is set up. */
    actionTarget: (): ActionTarget | undefined => service ? { root: service.root, key: service.state.key } : undefined,
    /** A press on Send or Send undo clears the last "Not sent" notice; its outcome may set a new one. */
    commandReceived(command: string) { if (SEND_COMMANDS.has(command)) notePress(undefined); },
    commandFinished(command: string, result: ActionResult) { if (SEND_COMMANDS.has(command)) { const text = pressNotice(result, sendLabel(command)); if (text) notePress(text); } },
    viewForTest: view,
    /** When the summary shown (or the undo summary) last changed. */
    summaryChangedAtForTest: () => (undoing ?? standing)?.changedAt,
    /** The answer the next Send confirmation gets, in place of the modal. */
    answerConfirmationForTest: (answer: string | undefined) => { testAnswers.push(answer); },
    /** A message as the project view posts it, e.g. a press. */
    viewMessageForTest: (surface: Surface, message: unknown) => { const handle = viewListeners.get(surface); if (!handle) throw new Error(`No ${surface} view is open.`); handle(message); },
    rendersForTest: () => renderLog ?? [],
    /** True once the outgoing summary reflects the current files and drafts. */
    summarySettledForTest: () => !standingBusy && !standingTimer && !sending,
    threadForTest: (id: string) => threads.find(thread => ids.get(thread) === id),
    commentingRangesForTest: commentingRanges,
    snapshot: () => ({ threadCount: threads.length, disposedInUse: threads.filter(thread => disposedThreads.has(thread)).length, highlights: highlightComments, decorations: { ...decorated }, labels: rows.map(r => r.anchor.label), panel: !!panel, sidebar: !!overview, cached, state: stateLabel(), activePath: lastSource && service ? relative(service.root, lastSource.document.uri.fsPath).replace(/\\/g, '/') : undefined, preview: prepared && { id: prepared.id, kind: prepared.kind, stale: prepared.stale, complete: prepared.complete, files: previewFiles().length, pictures: previewPictures()?.map(f => f.path) ?? [] } }),
  };
}
