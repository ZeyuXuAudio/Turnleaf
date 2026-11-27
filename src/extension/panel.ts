import { randomUUID } from 'node:crypto';
import { ReviewRow, anchorLabel, localStatus, textGone } from '../core/review';
import { Reviews } from '../core/storage';
import { suggestionAuthors } from '../core/suggestions';
import { brandMark, icon, Icon } from './icons';
import { panelStyle } from './panelStyle';
import type { CommentChange } from '../core/projectStore';
import { commentChanges, historyStyle } from './history';
import { clip, initials, shortDateTime } from './format';
import type { DeletionDisplay } from './deletionDisplay';

/** The Get latest preview: what Apply would write to the local files. */
export interface PreviewView {
  id: string; stale?: string; complete?: string;
  /** kept: a first-sync file where the local version was kept; it is listed as going out after Apply. */
  files: { path: string; added: number; removed: number; conflict?: boolean; firstSync?: boolean; kept?: boolean; note?: string }[];
  /** Pictures and PDF figures, in the same list: `summary` is e.g. "changed on Overleaf · 120 KB → 134 KB"; conflict: changed on both sides and not yet chosen. */
  pictures?: { path: string; summary: string; conflict?: boolean; choose?: boolean; note?: string }[];
  selectedPath?: string; comments?: CommentChange[];
}
/** A file row of a summary. mark: why Undo this send could not bring it back. changed: differs from the summary shown at the last click. */
export interface SummaryFile { path: string; added: number; removed: number; mark?: string; changed?: boolean; note?: string }
/**
 * A picture row of a summary: `summary` is e.g. "replaces Overleaf file · 120 KB → 134 KB";
 * sends: false for a row that cannot go out, whose `note` says why.
 */
export interface SummaryPicture { path: string; summary: string; sends: boolean; created?: boolean; note?: string; changed?: boolean }
/** Why nothing can be sent now, and the single way out. */
export interface SummaryBlock { way: 'recover' | 'getLatest' | 'draft' | 'fix'; message: string; draftId?: string }
/** Where Show in editor goes for a summary row. */
export interface Place { command: 'openThread' | 'openSuggestion'; path?: string; value: string }
/** Which kinds of review items the Review tab and editor show; an item shows when any of its kinds is on. */
export interface ReviewFilter { open: boolean; resolved: boolean; suggestions: boolean; outgoing: boolean }
export const reviewFilterDefault: ReviewFilter = { open: true, resolved: false, suggestions: true, outgoing: true };
export const matchesThreadFilter = (resolved: boolean, pending: boolean, filter: ReviewFilter): boolean =>
  (resolved ? filter.resolved : filter.open) || (filter.outgoing && pending);
export const matchesSuggestionFilter = (decided: boolean, filter: ReviewFilter): boolean =>
  filter.suggestions || (filter.outgoing && decided);
/**
 * The standing outgoing summary: what Send would write, from the saved files, the
 * queued comment changes and the last observed Overleaf state.
 */
export interface OutgoingView {
  /** Being recomputed: the rows are the previous ones and Send waits. */
  busy?: boolean;
  /** Send waits: 'refreshing' while the summary is recomputed or for 650 ms after it changed, 'sending' while a Send runs. */
  sendWait?: 'refreshing' | 'sending';
  /** What the summary is updating for, shown as "Updating: …" while Send waits. */
  updating?: string;
  /** Why the last press on Send (or Send undo) did not send. */
  pressNotice?: string;
  /** The summary's revision, carried by its Send button: a press on an older one does not send. */
  revision?: number;
  files: SummaryFile[]; comments: CommentChange[]; pictures?: SummaryPicture[];
  /** Comment change ID → where Show in editor goes. */
  places?: Record<string, Place>;
  /** Comment change ID → why Undo this send could not bring it back. */
  marks?: Record<string, string>;
  /** Comment change IDs that differ from the summary shown at the last click. */
  changed?: string[];
  /** Overleaf changes that Send applies to the local files first. */
  incoming?: { files: SummaryFile[]; comments: CommentChange[]; changed?: string[]; places?: Record<string, Place> };
  blocked?: SummaryBlock;
  /** Selected files with unsaved editor changes, which the summary does not include. */
  unsaved?: string[];
  /** When Overleaf was last read, shown while that state is not live. */
  asOf?: string;
  /** How the next Send checks Overleaf: the chosen check, and whether the live connection is open for Fast. */
  check?: { mode: 'full' | 'fast'; live: boolean };
  notice?: string; selectedPath?: string; trackChanges?: boolean;
}
/** The summary of Undo this send for one Send record. */
export interface UndoView {
  record: string; time: string; busy?: boolean;
  /** Send waits: 'refreshing' while the summary is recomputed or for 650 ms after it changed, 'sending' while a Send runs. */
  sendWait?: 'refreshing' | 'sending';
  /** What the summary is updating for, shown as "Updating: …" while Send waits. */
  updating?: string;
  /** Why the last press on Send (or Send undo) did not send. */
  pressNotice?: string;
  /** The summary's revision, carried by its Send button: a press on an older one does not send. */
  revision?: number;
  files: SummaryFile[]; comments: CommentChange[]; changed?: string[]; pictures?: SummaryPicture[];
  stays: { label: string; path?: string; reason: string }[];
  blocked?: SummaryBlock; unsaved?: string[]; notice?: string; selectedPath?: string;
}
/** A suggested change, positioned in the local text, with the decision waiting for Send. */
export interface SuggestionRow { id: string; path: string; line: number; pos: number; kind: 'insert' | 'delete'; text: string; author: string; authorId?: string; timestamp?: string | number; decision?: 'accept' | 'reject'; }
/** The thread shown in the larger view's detail column. */
export interface ThreadDetail { row: ReviewRow; anchorText: string; context: { line: number; text: string; anchored: boolean }[]; }
export interface ProjectView {
  name?: string; server?: string; files: string[]; snapshotBranch?: string; version?: string;
  /** unplaced: a new comment whose selected text changed, so it needs Update selection. */
  drafts?: { id: string; kind: string; path: string; threadId?: string; text?: string; uncertain?: boolean; unplaced?: boolean; place?: Place; line?: number; suggestion?: { kind: 'insert' | 'delete'; text: string } }[];
  state: string; fetchedAt?: string; writes: boolean; activePath?: string;
  rows: ReviewRow[]; suggestionRows?: SuggestionRow[]; reviews: Reviews; connected?: boolean; checking?: boolean; linked?: boolean;
  preview?: PreviewView; busy?: boolean; interval?: number | 'live'; live?: boolean; checkedAt?: string;
  freshness?: string; recovery?: boolean; allComments?: boolean;
  openComments?: number; suggestions?: number; selectedThread?: string; highlightComments?: boolean; outlineMarkers?: boolean;
  /** The signed-in Overleaf user, whose own messages can be edited. */
  userId?: string;
  reviewFilter?: ReviewFilter;
  /** Where a comment's gutter marker goes: below its paragraph (none when no blank line follows) or on the commented line. */
  commentMarkers?: 'belowParagraph' | 'commentedLine';
  /** How suggested deletions are drawn in the editor (`turnleaf.deletionDisplay`). */
  deletionDisplay?: DeletionDisplay;
  /** Local review files (comment files for AI agents and scripts) are on. */
  reviewFiles?: boolean;
  outgoing?: OutgoingView;
  /** Set while the summary block shows an undo instead of the outgoing changes. */
  undo?: UndoView;
  /** The latest Send record, while the status still reports it: offers Undo. */
  undoLatest?: string;
  detail?: ThreadDetail;
}
const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
const draftLabels: Record<string, string> = { createThread: 'New comment', reply: 'Reply', editMessage: 'Edit message', deleteMessage: 'Delete message', deleteThread: 'Delete thread', resolve: 'Resolve thread', reopen: 'Reopen thread', acceptChange: 'Accept suggestion', rejectChange: 'Reject suggestion' };
const suggestionText = (s: { kind: 'insert' | 'delete'; text: string }, length = 80) => `${s.kind === 'insert' ? 'Added' : 'Deleted'}: <span class="${s.kind === 'insert' ? 'added' : 'removed strike'}">${escape(clip(s.text.replace(/\n/g, '⏎'), length))}</span>`;
const commandIcons: Record<string, Icon> = {
  pull: 'down', applyReviewed: 'down', send: 'up', sendUndo: 'up',
  checkRemote: 'refresh', openOverleaf: 'external', showReviewPanel: 'expand',
  reviewDetails: 'info', cancelPreview: 'close', toggleHighlights: 'eye',
};
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const when = shortDateTime;
// The sidebar's title bar already offers refresh and the larger view; the
// larger editor view has no title bar, so its footer keeps the refresh control.
// The larger view adds a second column with the selected thread in full.
export type Surface = 'sidebar' | 'panel';
export function projectContent(view: ProjectView, surface: Surface = 'sidebar'): string {
  const p = view.preview, ready = p && !p.stale && !p.complete;
  const configured = !!view.connected && !!view.linked && view.files.length > 0;
  const attrs = p ? `data-preview="${escape(p.id)}"` : '';
  const action = (command: string, label: string, options: { primary?: boolean; disabled?: boolean; className?: string; attrs?: string; icon?: Icon; title?: string } = {}) => {
    const glyph = options.icon ?? commandIcons[command];
    return `<button type="button" class="${options.className ?? 'button'}${options.primary ? ' primary' : ''}" data-command="${command}" ${options.attrs ?? ''}${options.title ? ` title="${escape(options.title)}"` : ''}${options.disabled || view.busy ? ' disabled' : ''}>${glyph ? icon(glyph) : ''}<span class="button-label">${label}</span></button>`;
  };
  const small = (command: string, label: string, options: Parameters<typeof action>[2] = {}) => action(command, label, { ...options, className: `button small${options.className ? ' ' + options.className : ''}` });
  const compact = (command: string, label: string, glyph: Icon, extra = '') => `<button type="button" class="icon-button" data-command="${command}" aria-label="${label}" title="${label}" ${extra}${view.busy ? ' disabled' : ''}>${icon(glyph)}</button>`;
  const o = view.undo ? undefined : view.outgoing, u = view.undo;
  const sending = (x?: { pictures?: SummaryPicture[] }) => x?.pictures?.filter(f => f.sends).length ?? 0;
  const outgoingCount = o ? o.files.length + o.comments.length + sending(o) : 0;
  const incomingWaiting = !p && (/^Incoming/.test(view.freshness ?? '') || /^Incoming changes/.test(view.state));
  const conflicted = !!ready && (p.files.some(f => f.conflict) || !!p.pictures?.some(f => f.conflict));
  // Only the step the current state calls for is filled. A blocked summary names
  // its single way out, and that step is the filled button.
  const incomingCount = (p?.files.length ?? 0) + (p?.pictures?.length ?? 0) + (p?.comments?.length ?? 0);
  const sendingOff = 'Sending is off for this project';
  // While Send waits, its label says why.
  const revisionAttr = (x: { revision?: number }) => x.revision === undefined ? '' : `data-revision="${x.revision}"`;
  const waitLabel = (x: { sendWait?: 'refreshing' | 'sending' }, label: string) => x.sendWait === 'sending' ? 'Sending…' : x.sendWait === 'refreshing' ? 'Refreshing…' : label;
  let mainActions: string;
  if (u) mainActions = (u.unsaved?.length ? action('saveAll', 'Save all', { primary: true, icon: 'file' })
    : view.writes ? action('sendUndo', waitLabel(u, 'Send undo'), { primary: true, attrs: revisionAttr(u), disabled: !!u.blocked || !!u.busy || !!u.sendWait || !(u.files.length + u.comments.length + sending(u)) })
    : action('enableWrites', 'Enable sending', { primary: true, icon: 'settings', title: sendingOff })) + action('cancelUndo', 'Cancel', { icon: 'close' });
  else if (ready) mainActions = action('applyReviewed', incomingCount ? `Apply (${incomingCount})` : 'Use this baseline', { primary: true, disabled: conflicted, attrs, title: incomingCount ? `Apply ${plural(incomingCount, 'update')}` : undefined });
  else {
    const way = o?.blocked?.way;
    const send = !o || o.blocked ? ''
      : o.unsaved?.length ? action('saveAll', 'Save all', { primary: true, icon: 'file', title: 'Save the selected files so the summary includes their edits' })
      : !outgoingCount ? ''
      : view.writes ? action('send', waitLabel(o, o.incoming ? 'Apply &amp; send' : 'Send'), { primary: !p?.stale, attrs: revisionAttr(o), disabled: !!o.busy || !!o.sendWait, title: o.sendWait === 'refreshing' ? 'Send waits until the summary has settled, so it sends what you see' : o.incoming ? 'Apply the Overleaf changes to your files, then send what is listed' : 'Send what is listed' })
      : action('enableWrites', 'Enable sending', { primary: true, icon: 'settings', title: sendingOff });
    const recover = way === 'recover' ? action('recoverLocalApply', 'Recover local apply', { primary: true, icon: 'history' }) : '';
    mainActions = action('pull', 'Get latest', { primary: !!p?.stale || way === 'getLatest' || !send && !recover && incomingWaiting, disabled: !configured }) + recover + send;
  }
  // What the state line is about, shown as the icon and tint of the status block.
  const kind = !view.connected && !view.checking ? 'offline'
    : p?.stale || view.recovery || conflicted || o?.blocked || o?.notice || o?.pressNotice || u?.blocked || u?.notice || u?.pressNotice || /interrupted|may be stale|^Local review files:/.test(view.state) ? 'warning'
    : ready || u ? 'review'
    : incomingWaiting ? 'incoming'
    : outgoingCount ? 'unsent'
    : /^(Up to date|Sent and verified)/.test(view.state) ? 'synced' : 'info';
  const kindIcon: Record<typeof kind, Icon> = { offline: 'info', warning: 'warning', review: 'diff', incoming: 'down', unsent: 'up', synced: 'check', info: 'info' };
  const counts = view.linked ? `<span class="summary-counts"><span>${icon('comment')}${view.openComments ?? view.rows.filter(r => !r.thread.resolved).length} open</span><span>${icon('suggestion')}${plural(view.suggestions ?? 0, 'suggestion')}</span></span>` : '<span></span>';
  const undoLink = view.undoLatest && !u ? small('undoSend', 'Undo', { className: 'ghost undo-link', icon: 'history', attrs: `data-value="${escape(view.undoLatest)}"`, title: 'Undo this send: take it back from Overleaf. Your local files stay as they are.' }) : '';
  const header = `<header class="project-header">
    <div class="project-title">${brandMark}<h1 title="${escape(view.name ?? 'Turnleaf')}">${escape(view.name ?? 'Turnleaf')}</h1>${view.linked ? compact('openOverleaf', 'Open project on Overleaf', 'external') : ''}</div>
    <div class="status status-${kind}">${icon(kindIcon[kind])}<div class="status-text"><p class="state" role="status">${escape(view.state)}</p><p class="connection">${view.connected ? 'Connected' : view.checking ? 'Connecting' : 'Sign in to connect'}${view.server ? ' · ' + escape(view.server.replace(/^https?:\/\//, '')) : ''}</p></div>${undoLink}</div>
    ${view.linked ? `<div class="actions main-actions">${mainActions}</div>` : ''}
  </header>`;
  const cookieHelp = `<details class="setup-help"><summary>Where do I find the cookie?</summary><ol><li>Sign in to Overleaf in Chrome.</li><li>Open <strong>⋮ → More Tools → Developer Tools</strong>, or press <strong>⌘⌥I</strong> on Mac / <strong>Ctrl+Shift+I</strong> on Windows.</li><li>Select <strong>Application → Storage → Cookies → https://www.overleaf.com</strong> (or your server).</li><li>Copy the complete <strong>overleaf_session2</strong> value with URL decoding off. Paste only the value into the masked editor prompt.</li></ol><p>The cookie stays in the editor’s secret storage.</p></details>`;
  const steps = [
    { done: !!view.connected, title: 'Sign in', description: 'Sign in on Overleaf in a separate browser window. It closes once you are signed in.', command: 'signIn', label: view.connected ? 'Reconnect' : 'Sign in with browser' },
    { done: !!view.linked, title: 'Choose project', description: view.name ?? 'Select a project from your account.', command: 'linkProject', label: view.linked ? 'Change' : 'Choose project' },
    { done: view.files.length > 0 && !!view.linked, title: 'Choose source files', description: view.files.join(', ') || 'Select the files to synchronize.', command: 'configureFiles', label: view.files.length ? 'Change' : 'Choose files' },
    { done: view.writes, title: 'Enable sending', description: 'Allow reviewed file and comment changes to be sent.', command: 'enableWrites', label: view.writes ? 'Disable' : 'Enable sending' },
  ];
  const firstIncomplete = steps.findIndex(s => !s.done);
  // Comment files for AI agents and scripts: on by default, so an agent finds them without a click.
  const agentFiles = view.linked ? `<div class="agent-files"><div class="step-heading">${icon('file')}<strong>AI agents and scripts</strong><button type="button" class="switch" role="switch" data-command="toggleReviewFiles" aria-checked="${!!view.reviewFiles}"${view.busy ? ' disabled' : ''}><span class="track" aria-hidden="true"><span class="thumb"></span></span>${view.reviewFiles ? 'On' : 'Off'}</button></div>
    <p class="step-content">${view.reviewFiles ? 'Comments are kept as files in <code>.turnleaf/projects/…/review/</code>. Agents and scripts can read them and queue replies, resolutions and new comments there.' : 'Turn on to keep comments as files that agents and scripts can read, and where they can queue replies, resolutions and new comments.'} What they queue is listed as going out and is published only by Send.</p>
    ${view.reviewFiles ? `<div class="actions">${small('openReviewFiles', 'Open overview', { icon: 'file' })}</div>` : ''}</div>` : '';
  const setup = `<div class="setup">
    <div class="setup-status">${icon('settings')}<span>Project setup</span><span class="setup-progress">${configured ? (view.writes ? 'Complete' : 'Sending off') : `${steps.filter(s => s.done).length} / 4`}</span></div>
    <div class="setup-body"><ol class="steps">${steps.map((s, n) => `<li>
      <div class="step-heading">${s.done ? icon('check') : `<span class="step-number">${n + 1}</span>`}<strong>${s.title}</strong>${s.done ? small(s.command, s.label, { className: 'push-right' }) : ''}</div>
      ${!s.done && (configured || n === firstIncomplete) ? `<div class="step-content"><p>${escape(s.description)}</p>${action(s.command, s.label, { primary: true })}${n === 0 ? `<div class="actions">${small('signInWithCookie', 'Use a session cookie instead', { className: 'ghost' })}</div>${cookieHelp}` : ''}</div>` : s.done && n > 0 && n < 3 ? `<p class="step-content">${escape(s.description)}</p>` : ''}
    </li>`).join('')}</ol>${configured ? '' : `<div class="actions">${small('openWalkthrough', 'Getting started guide', { icon: 'info', className: 'ghost' })}</div>`}<details class="setup-help marker-style"><summary>Review appearance</summary><p class="muted">Markers with word wrap on</p><div class="segmented" role="group" aria-label="Comment markers">${action('setCommentMarkers', 'Below the paragraph', { className: 'segment', attrs: `data-value="belowParagraph" aria-pressed="${view.commentMarkers !== 'commentedLine'}"` })}${action('setCommentMarkers', 'On the commented line', { className: 'segment', attrs: `data-value="commentedLine" aria-pressed="${view.commentMarkers === 'commentedLine'}"` })}</div><p class="muted">${view.commentMarkers === 'commentedLine' ? 'The marker is on the line where the comment ends. Cursor repeats it on every wrapped row of that line.' : 'The marker is on the blank line under the commented line. Without a blank line there, the highlighted text shows the comment; hover it to open the thread.'}</p><div class="actions">${small('toggleOutlineMarkers', view.outlineMarkers ? 'Restore editor markers' : 'Use outline comment markers', { icon: 'comment' })}</div><p class="muted">Linked workspaces start with clear outline markers and a transparent gutter. Restore brings back your previous appearance and keeps that choice. If markers look like solid blocks, Use outline comment markers repairs their colors.</p><p class="muted">Suggested deletions</p><div class="segmented" role="group" aria-label="Suggested deletions">${([['inline', 'Struck through'], ['marker', 'Marker'], ['inlayHint', 'Inlay hint']] as const).map(([value, label]) => action('setDeletionDisplay', label, { className: 'segment', attrs: `data-value="${value}" aria-pressed="${(view.deletionDisplay ?? 'inline') === value}"` })).join('')}</div><p class="muted">${view.deletionDisplay === 'marker' ? 'The character at the deletion point is marked and no text is added, so word wrap is unchanged. Hover the mark to see the deleted text.' : view.deletionDisplay === 'inlayHint' ? 'The deleted text is an inlay hint, which word wrap counts. It uses your inlay hint colors; with inlay hints off, the marker is shown instead.' : 'The deleted text is shown struck through. Word wrap does not count it, so a wrapped row with a long deletion can run past the editor\'s edge; Marker or Inlay hint avoids that.'}</p></details>${agentFiles}${view.connected ? `<div class="actions">${small('signOut', 'Sign out')}</div>` : ''}</div>
  </div>`;
  const fileRow = (f: { path: string; added: number; removed: number; conflict?: boolean }, extra: string, label: string, pressed: boolean) =>
    action('openPreviewDiff', `<span class="file-name">${escape(f.path).replace(/\//g, '/<wbr>')}</span><span class="counts"><span class="added">+${f.added}</span><span class="removed">−${f.removed}</span></span>${f.conflict ? '<span class="conflict">Conflict</span>' : ''}`, { className: 'file-button', icon: 'diff', attrs: `data-path="${escape(f.path)}" ${extra} ${attrs} aria-pressed="${pressed}" aria-label="${label}"` });
  // A picture row: its path and what Apply does with sizes in place of line counts; a click opens the side-by-side comparison.
  const pictureRow = (f: NonNullable<PreviewView['pictures']>[number], pressed: boolean) =>
    action('openPreviewDiff', `<span class="file-name">${escape(f.path).replace(/\//g, '/<wbr>')}</span><span class="counts picture-summary">${escape(f.summary)}</span>${f.conflict ? '<span class="conflict">Conflict</span>' : ''}`, { className: 'file-button', icon: 'file', attrs: `data-path="${escape(f.path)}" data-value="picture" ${attrs} aria-pressed="${pressed}" aria-label="${escape(f.path)}: ${escape(f.summary)}${f.conflict ? ', conflict' : ''}. Compare"` });
  const draftOf = (change: CommentChange) => view.drafts?.find(d => d.id === (change.draftId ?? change.id));
  // Update selection is offered only when a new comment could not follow its text.
  const unplacedReason = 'The text this comment was on changed. Select the text again in the editor, then click Update selection.';
  const draftButtons = (change: CommentChange) => { const draft = draftOf(change); return draft ? `${draft.text && !draft.uncertain ? small('editDraft', 'Edit', { attrs: `data-value="${escape(draft.id)}"` }) : ''}${draft.kind === 'createThread' && !draft.uncertain && draft.unplaced ? small('reattachDraft', 'Update selection', { attrs: `data-value="${escape(draft.id)}"`, title: unplacedReason }) : ''}${small('discardDraft', 'Discard', { attrs: `data-value="${escape(draft.id)}"` })}` : ''; };
  const unplacedNote = (change: CommentChange) => draftOf(change)?.unplaced ? `<p class="row-reason">${escape(unplacedReason)}</p>` : '';
  // The file and line of a row; with a place, a link to it in the editor.
  const location = (path: string, line: number | undefined, place: Place | undefined) => {
    const label = `${escape(path)}${line ? ` · L${line}` : ''}`;
    return place ? `<button type="button" class="place-link" data-command="${place.command}" ${place.path ? `data-path="${escape(place.path)}" ` : ''}data-value="${escape(place.value)}" title="Show in editor"${view.busy ? ' disabled' : ''}>${label}</button>` : `<span class="meta">${label}</span>`;
  };
  const showButton = (place?: Place) => place ? small(place.command, 'Show in editor', { attrs: `${place.path ? `data-path="${escape(place.path)}" ` : ''}data-value="${escape(place.value)}"` }) : '';
  const rowActions = (place: Place | undefined, drafts: boolean) => (change: CommentChange) => {
    const buttons = showButton(place) + (drafts ? draftButtons(change) : '');
    return (drafts ? unplacedNote(change) : '') + (buttons ? `<div class="actions">${buttons}</div>` : '');
  };
  const draftActions = rowActions(undefined, true);
  const previewChanges = (changes: CommentChange[], title: string) => changes.length ? `<h3>${title} (${changes.length})</h3>${commentChanges(changes)}` : '';
  const review = p ? `<section class="section" aria-label="Change preview">
    <div class="section-title"><h2>${icon('down')}Changes to local</h2></div>
    ${p.stale ? `<div class="notice"><p>Preview out of date: ${escape(p.stale)}</p>${action('pull', 'Refresh preview', { primary: true, icon: 'refresh' })}</div>` : p.complete ? `<p class="muted">${escape(p.complete)}</p>` : ''}
    <div class="direction"><span>Local now</span><span aria-hidden="true">→</span><strong>After merge</strong></div>
    <h3>${p.pictures?.length ? `Files (${p.files.length + p.pictures.length})` : `File text${p.files.length ? ` (${p.files.length})` : ''}`}</h3>${p.files.length ? `<p class="muted">The diff shows file text only. Comment changes are listed below and noted at their lines in the diff.</p>` : ''}
    <ul class="file-list">${p.files.map(f => `<li>${fileRow(f, '', `${escape(f.path)}: ${f.added} added, ${f.removed} removed${f.conflict ? ', conflict' : ''}. Open diff`, p.selectedPath === f.path)}${f.conflict ? `${f.firstSync ? '<p class="muted">Not synchronized before, so there is no shared version to merge from. Choose a version or merge manually.</p>' : ''}<div class="actions">${f.firstSync ? small('useRemoteVersion', 'Use Overleaf version', { disabled: !!p.stale, attrs: `data-path="${escape(f.path)}" ${attrs}` }) + small('keepLocalVersion', 'Keep my version', { disabled: !!p.stale, attrs: `data-path="${escape(f.path)}" ${attrs}` }) : ''}${small('resolveConflict', f.firstSync ? 'Merge manually' : 'Resolve in editor', { disabled: !!p.stale, attrs: `data-path="${escape(f.path)}" ${attrs}` })}</div>${f.note ? `<p class="muted">${escape(f.note)}</p>` : ''}` : f.note ? `<p class="muted">${escape(f.note)}</p>` : ''}</li>`).join('')}${(p.pictures ?? []).map(f => `<li>${pictureRow(f, p.selectedPath === `picture:${f.path}`)}${f.choose ? `<div class="actions">${small('useRemoteVersion', 'Use Overleaf version', { disabled: !!p.stale, attrs: `data-path="${escape(f.path)}" data-value="picture" ${attrs}` })}${small('keepLocalVersion', 'Keep my version', { disabled: !!p.stale, attrs: `data-path="${escape(f.path)}" data-value="picture" ${attrs}` })}</div>` : ''}${f.note ? `<p class="muted">${escape(f.note)}</p>` : ''}</li>`).join('')}</ul>
    ${p.files.length || p.pictures?.length ? '' : '<p class="muted">No file text changes.</p>'}
    ${previewChanges(p.comments ?? [], 'Comments')}${p.comments?.length ? '' : '<p class="muted">No comment changes.</p>'}
    <div class="actions">${small('reviewDetails', 'Review details', { attrs })}${small('cancelPreview', 'Close preview')}</div>
  </section>` : '';
  // The summary block: what goes out on the next Send, always in view above the tabs.
  const warn = (reason: string) => `<span class="row-mark" role="img" aria-label="${escape(reason)}" title="${escape(reason)}">${icon('warning')}</span>`;
  const changedBadge = '<span class="badge warning">Changed</span>';
  // Fast applies only through the live connection; without it the switch shows Full and says why.
  const sendCheck = (c: NonNullable<OutgoingView['check']>) => {
    const fast = c.mode === 'fast' && c.live, segment = (value: 'full' | 'fast', label: string) => action('setSendCheck', label, { className: 'segment', disabled: value === 'fast' && !c.live, title: value === 'fast' && !c.live ? 'Fast needs live updates' : undefined, attrs: `data-value="${value}" aria-pressed="${value === 'fast' ? fast : !fast}"` });
    const note = fast ? `${icon('warning')}Re-reads only files Overleaf reported as edited, and the files sent.`
      : c.mode === 'fast' ? 'Fast needs live updates. Full check used.' : 'Re-reads every selected file before and after sending.';
    return `<div class="send-check"><p class="muted">Check before sending</p><div class="segmented" role="group" aria-label="Check before sending">${segment('full', 'Full')}${segment('fast', 'Fast')}</div><p class="muted summary-foot">${note}</p></div>`;
  };
  const summaryFile = (f: SummaryFile, value: string, label: string, selected?: string) => `<li${f.changed ? ' class="row-changed"' : ''}>${action('openOutgoingDiff', `<span class="file-name">${escape(f.path).replace(/\//g, '/<wbr>')}</span><span class="counts"><span class="added">+${f.added}</span><span class="removed">−${f.removed}</span></span>${f.mark ? warn(value === 'undo' ? `${f.mark}. Sending again restores the text, not what was attached to it.` : `${f.mark}. Undo this send cannot bring that back.`) : ''}${f.changed ? changedBadge : ''}`, { className: 'file-button', icon: 'diff', attrs: `data-path="${escape(f.path)}" data-value="${value}" aria-pressed="${selected === (value ? value + ':' : '') + f.path}" aria-label="${escape(f.path)}: ${f.added} added, ${f.removed} removed. ${label}"` })}${f.mark ? `<p class="row-reason">${escape(f.mark)} · ${value === 'undo' ? 'not restored by sending again' : 'cannot be undone'}</p>` : ''}${f.note ? `<p class="muted">${escape(f.note)}</p>` : ''}</li>`;
  // The words a comment change adds, edits or removes.
  const words = (c: CommentChange) => c.suggestion ? c.suggestion.text : (c.after?.messages.find(m => !c.before?.messages.some(old => old.id === m.id && old.text === m.text)) ?? c.before?.messages.find(m => !c.after?.messages.some(next => next.id === m.id)))?.text ?? '';
  const summaryComment = (c: CommentChange, options: { mark?: string; changed?: boolean; actions?: boolean; open?: boolean; place?: Place } = {}) => {
    const line = c.line ?? c.suggestion?.line, text = clip(words(c).replace(/\s+/g, ' '), 60), unplaced = options.actions && draftOf(c)?.unplaced;
    return `<details class="out-row${options.changed ? ' row-changed' : ''}" data-section="row:${escape(c.id)}" data-force="${options.open || unplaced ? 'open' : ''}"><summary><span class="out-label">${escape(c.label)}</span>${location(c.path, line, options.place)}${text ? `<span class="out-words">${escape(text)}</span>` : ''}${options.changed ? changedBadge : ''}${unplaced ? `<span class="row-reason">${warn(unplacedReason)}Needs a new selection</span>` : ''}${options.mark ? `<span class="row-reason">${warn(`${options.mark}. Undo this send cannot bring it back.`)}${escape(options.mark)} · cannot be undone</span>` : ''}</summary>${commentChanges([c], rowActions(options.place, !!options.actions))}</details>`;
  };
  const totals = (files: SummaryFile[], comments: number, pictures = 0) => [files.length ? `${plural(files.length, 'file')} <span class="counts"><span class="added">+${files.reduce((n, f) => n + f.added, 0)}</span><span class="removed">−${files.reduce((n, f) => n + f.removed, 0)}</span></span>` : '', pictures ? plural(pictures, 'picture') : '', comments ? plural(comments, 'comment change') : ''];
  // A picture row of a summary: sizes in place of line counts; a click opens the side-by-side comparison.
  const summaryPicture = (f: SummaryPicture, value: string, selected?: string, tracking?: boolean) => {
    const reason = !f.sends ? f.note : tracking ? f.created ? 'New for everyone, not a suggestion.' : 'Replaces the file for everyone, not a suggestion.' : undefined;
    return `<li${f.changed ? ' class="row-changed"' : ''}>${action('openOutgoingDiff', `<span class="file-name">${escape(f.path).replace(/\//g, '/<wbr>')}</span><span class="counts picture-summary">${escape(f.summary)}</span>${f.changed ? changedBadge : ''}`, { className: 'file-button', icon: 'file', attrs: `data-path="${escape(f.path)}" data-value="${value}" aria-pressed="${selected === `${value}:${f.path}`}" aria-label="${escape(f.path)}: ${escape(f.summary)}. Compare"` })}${reason ? `<p class="${f.sends ? 'muted' : 'row-reason'}">${escape(reason)}</p>` : ''}${f.sends && f.note ? `<p class="muted">${escape(f.note)}</p>` : ''}</li>`;
  };
  // Each list has a toggle on its head line; the totals stay visible when the rows are hidden.
  // `force`: what currently needs a look. A new value opens a hidden list once.
  const group = (id: string, glyph: Icon, title: string, parts: string[], body: string, force: unknown[] = []) => `<details class="summary-group" data-section="${id}" data-force="${force.some(part => Array.isArray(part) ? part.length : part) ? escape(JSON.stringify(force)) : ''}" open><summary>${icon(glyph)}<span class="group-head"><strong>${title}</strong>${parts.filter(Boolean).map(part => ` · <span>${part}</span>`).join('')}</span></summary><div class="group-body">${body}</div></details>`;
  const summaryLines = (x: { notice?: string; blocked?: SummaryBlock; unsaved?: string[]; pressNotice?: string; updating?: string; sendWait?: string }) => `${x.pressNotice ? `<p class="summary-line attention press-notice" role="status">${icon('warning')}<span>${escape(x.pressNotice)}</span></p>` : ''}${x.sendWait === 'refreshing' && x.updating ? `<p class="summary-line muted updating">${icon('refresh')}<span>Updating: ${escape(x.updating)}</span></p>` : ''}${x.notice ? `<p class="summary-line attention" role="status">${icon('warning')}<span>${escape(x.notice)}</span></p>` : ''}${x.blocked ? `<p class="summary-line attention" role="status">${icon('warning')}<span>${escape(x.blocked.message)}</span></p>` : ''}${x.unsaved?.length ? `<p class="summary-line">${icon('edit')}<span>Unsaved edits in ${escape(x.unsaved.join(', '))} are not included.</span></p>` : ''}`;
  let summary = '';
  if (u) {
    const comments = u.comments.filter(c => !c.suggestion), taken = u.files.length + comments.length + sending(u);
    summary = `<section class="outgoing-summary${u.busy ? ' recomputing' : ''}" aria-label="Undo summary">
    <p class="summary-head">${icon('history')}<strong>Undo of the send from ${escape(when(u.time))}</strong></p>${summaryLines(u)}
    ${taken ? group('undo-taken', 'up', 'Taken back from Overleaf', totals(u.files, comments.length, sending(u)), `<ul class="file-list">${u.files.map(f => summaryFile(f, 'undo', 'Open diff: Overleaf now to after undo', u.selectedPath)).join('')}${(u.pictures ?? []).map(f => summaryPicture(f, 'undo-picture', u.selectedPath)).join('')}</ul>${comments.map(c => summaryComment(c, { changed: u.changed?.includes(c.id) })).join('')}`, [u.files.filter(f => f.mark).map(f => f.path), u.notice ?? '']) : u.blocked ? '' : `<p class="summary-line">${icon('info')}<span>Nothing of this send can be taken back.</span></p>`}
    ${u.stays.length ? group('undo-stays', 'info', 'Stays as sent', [String(u.stays.length)], `<ul class="stay-list">${u.stays.map(row => `<li><strong>${escape(row.label)}</strong>${row.path && row.path !== row.label ? ` <span class="meta">${escape(row.path)}</span>` : ''}<p class="muted">${escape(row.reason)}</p></li>`).join('')}</ul>`) : ''}
    <p class="muted summary-foot">Your local files are not changed; these edits are listed as going out again afterwards.</p>
  </section>`;
  } else if (o && view.linked) {
    const marked = o.files.filter(f => f.mark).length + o.comments.filter(c => o.marks?.[c.id]).length;
    // Without a plan the queued comment changes stay in reach, so a blocking one can be revised or discarded.
    const waiting = o.blocked && !outgoingCount ? view.drafts ?? [] : [];
    // The draft that blocks Send comes first and says so; long texts fold to a few lines.
    const waitingCard = (draft: NonNullable<ProjectView['drafts']>[number]) => { const blocking = draft.id === o.blocked?.draftId; return `<div class="card${blocking ? ' blocking' : ''}"><div class="waiting-head"><strong>${escape(draftLabels[draft.kind] ?? draft.kind)}</strong>${location(draft.path, draft.line, draft.place)}${blocking ? '<span class="badge warning">Blocks Send</span>' : ''}</div>${draft.uncertain ? '<p class="warning">Earlier outcome uncertain. Inspect Sync history and Overleaf before discarding this draft.</p>' : ''}${draft.text ? `<p class="card-quote draft-text">${escape(draft.text)}</p>` : ''}${draft.suggestion ? `<p class="card-quote">${suggestionText(draft.suggestion, 200)}</p>` : ''}${rowActions(draft.place, true)({ id: draft.id, path: draft.path, label: '' })}</div>`; };
    const going = outgoingCount ? group('outgoing-list', 'up', 'Going out', [...totals(o.files, o.comments.length, sending(o)), marked ? `<span class="cannot-undo">${marked} cannot be undone</span>` : ''],
      `${o.files.length || o.pictures?.length ? `<ul class="file-list">${o.files.map(f => summaryFile(f, '', 'Open diff: Overleaf now to after send', o.selectedPath)).join('')}${(o.pictures ?? []).map(f => summaryPicture(f, 'picture', o.selectedPath, o.trackChanges)).join('')}</ul>` : ''}${o.comments.map(c => summaryComment(c, { mark: o.marks?.[c.id], changed: o.changed?.includes(c.id), actions: true, place: o.places?.[c.id] })).join('')}`,
      [o.files.filter(f => f.mark).map(f => f.path), o.comments.filter(c => o.marks?.[c.id]).map(c => c.id), o.notice ?? ''])
      : waiting.length ? group('outgoing-list', 'up', 'Waiting', [plural(waiting.length, 'comment change')], [...waiting].sort((a, b) => Number(b.id === o.blocked?.draftId) - Number(a.id === o.blocked?.draftId)).map(waitingCard).join(''), [o.blocked?.message ?? ''])
      // A blocked summary already names its reason above; the status says that nothing can be sent.
      : o.blocked ? '' : `<p class="summary-head">${icon('check')}<strong>Nothing to send</strong></p>`;
    // Pictures that cannot go out (linked, over the upload limit) keep their rows and reasons when nothing else does.
    const held = outgoingCount ? [] : o.pictures ?? [];
    const notSent = held.length ? group('outgoing-held', 'info', 'Not sent', [plural(held.length, 'picture')], `<ul class="file-list">${held.map(f => summaryPicture(f, 'picture', o.selectedPath, o.trackChanges)).join('')}</ul>`) : '';
    const coming = outgoingCount && o.incoming ? group('incoming-list', 'down', 'From Overleaf, applied to your files first', totals(o.incoming.files, o.incoming.comments.length),
      `<p class="muted">Collaborators changed other parts since your last sync. Apply &amp; send merges them into your files, then sends what is listed above.</p><ul class="file-list">${o.incoming.files.map(f => summaryFile(f, 'incoming', 'Open diff: local to after merge', o.selectedPath)).join('')}</ul>${o.incoming.comments.map(c => summaryComment(c, { changed: o.incoming!.changed?.includes(c.id), place: o.incoming!.places?.[c.id] })).join('')}`,
      [o.incoming.files.filter(f => f.changed).map(f => f.path), o.incoming.changed ?? []]) : '';
    summary = `<section class="outgoing-summary${o.busy ? ' recomputing' : ''}" aria-label="Outgoing summary"${o.busy ? ' aria-busy="true"' : ''}>${summaryLines(o)}${going}${notSent}${coming}
    ${outgoingCount && o.trackChanges && o.files.length ? '<p class="muted summary-foot">Track Changes is on: file edits arrive on Overleaf as your suggestions.</p>' : ''}
    ${o.check && outgoingCount ? sendCheck(o.check) : ''}
    ${o.asOf ? `<p class="muted summary-foot">${icon('clock')}Compared with Overleaf as of ${escape(o.asOf)}</p>` : ''}
    ${outgoingCount ? `<div class="actions">${small('reviewDetails', 'Review details')}</div>` : ''}
  </section>`;
  }
  const pending = new Set((view.drafts ?? []).map(draft => draft.threadId).filter(Boolean));
  // Only exceptions get a badge; an open, unchanged thread needs none.
  const badges = (row: ReviewRow) => {
    const local = localStatus(row.thread.id, view.reviews);
    return [pending.has(row.thread.id) && ['pending', 'Pending send'], row.thread.resolved && ['resolved', 'Resolved'], row.anchor.label !== 'unchanged' && (row.anchor.label === 'anchor removed'
      ? ['note', anchorLabel(row.anchor.label), 'Overleaf no longer has the text this comment was on. The thread is kept; reply, resolve or delete it as usual.']
      : ['warning', row.anchor.label]), local !== 'open locally' && ['local', local]]
      .filter((badge): badge is string[] => !!badge).map(([kind, text, title]) => `<span class="badge ${kind}"${title ? ` title="${escape(title)}"` : ''}>${escape(text)}</span>`).join('');
  };
  const replyBox = (id: string, rows = 1) => `<div class="reply-box"><textarea data-reply="${escape(id)}" rows="${rows}" placeholder="Reply…" aria-label="Reply, saved until Send"></textarea>${small('reply', 'Reply', { attrs: `data-value="${escape(id)}"`, title: 'Saved locally and listed as going out; Send publishes it' })}</div>`;
  const resolveButton = (row: ReviewRow) => row.thread.resolved
    ? compact('reopen', 'Reopen on send', 'refresh', `data-value="${escape(row.thread.id)}"`)
    : compact('resolve', 'Resolve on send', 'check', `data-value="${escape(row.thread.id)}"`);
  // Your own sent messages; pending ones are edited in the outgoing summary.
  const own = (message: ReviewRow['thread']['messages'][number]) => !!view.userId && message.authorId === view.userId && !!message.id && !message.id.startsWith('draft:');
  const messageActions = (row: ReviewRow, message: ReviewRow['thread']['messages'][number]) => own(message)
    ? `${compact('editMessage', 'Edit your comment', 'edit', `data-value="${escape(row.thread.id)}" data-message="${escape(message.id!)}"`)}${compact('deleteMessage', 'Delete your comment on send', 'trash', `data-value="${escape(row.thread.id)}" data-message="${escape(message.id!)}"`)}` : '';
  const lineChip = (row: ReviewRow) => !row.line ? '<span class="chip">Unplaced</span>' : textGone(row.anchor.label)
    ? `<span class="chip" title="Where the text was before it was deleted">near L${row.line}</span>` : `<span class="chip">L${row.line}</span>`;
  const goneText = (row: ReviewRow) => textGone(row.anchor.label) && row.excerpt ? row.excerpt + (row.excerpt.length >= 80 ? '…' : '') : '';
  const threadCard = (row: ReviewRow) => {
    const first = row.thread.messages[0], replies = row.thread.messages.length - 1, latest = replies ? row.thread.messages[replies] : undefined;
    const replyItem = (message: ReviewRow['thread']['messages'][number]) => `<button type="button" class="card-reply" data-id="${escape(row.thread.id)}" tabindex="-1"><span class="reply-head"><strong>${escape(message.author)}</strong><span class="meta">${escape(when(message.timestamp))}</span>${message.id?.startsWith('draft:') ? '<span class="badge pending">Pending send</span>' : ''}</span><span class="reply-text">${escape(message.text)}</span></button>`;
    // The newest reply under the first message, so the card shows where the discussion stands;
    // the reply count unfolds every reply in full in its place.
    const latestReply = latest ? replyItem(latest) : '';
    const foot = replies ? `<details class="card-replies" data-section="replies:${escape(row.thread.id)}"><summary><span class="meta reply-count">${plural(replies, 'reply', 'replies')}</span>${badges(row)}</summary><div class="reply-list">${row.thread.messages.slice(1).map(replyItem).join('')}</div></details>`
      : badges(row) ? `<div class="card-foot">${badges(row)}</div>` : '';
    return `<article class="card${view.selectedThread === row.thread.id ? ' selected' : ''}${row.thread.resolved ? ' resolved' : ''}">
      <div class="card-head"><span class="avatar">${escape(initials(first?.author ?? '?'))}</span><button type="button" class="card-main" data-id="${escape(row.thread.id)}" aria-pressed="${view.selectedThread === row.thread.id}"><strong>${escape(first?.author ?? 'Unknown author')}</strong><span class="meta">${escape(when(first?.timestamp))}${when(first?.timestamp) ? ' · ' : ''}${lineChip(row)}</span></button>${resolveButton(row)}</div>
      ${goneText(row) ? `<p class="card-quote gone" title="The text this comment was on">${escape(goneText(row))}</p>` : ''}
      <button type="button" class="card-text" data-id="${escape(row.thread.id)}" tabindex="-1">${escape(first?.text ?? '')}</button>
      <button type="button" class="text-toggle" data-text-toggle="${escape(row.thread.id)}" aria-expanded="false" hidden>Show more</button>
      ${latestReply}
      ${foot}
      ${surface === 'sidebar' && view.selectedThread === row.thread.id ? `${first && own(first) ? `<div class="card-tools">${messageActions(row, first)}</div>` : ''}${replyBox(row.thread.id)}` : ''}
    </article>`;
  };
  // Like Overleaf's review panel: accept and reject at the card's top right.
  const decideButton = (s: SuggestionRow, decision: 'accept' | 'reject') => {
    const label = s.decision === decision ? `Undo ${decision}` : `${decision === 'accept' ? 'Accept' : 'Reject'} on send`;
    return `<button type="button" class="icon-button decide ${decision}" data-command="${decision}Change" data-path="${escape(s.path)}" data-value="${escape(s.id)}" aria-pressed="${s.decision === decision}" aria-label="${label}" title="${label}"${view.busy ? ' disabled' : ''}>${icon(decision === 'accept' ? 'check' : 'close')}</button>`;
  };
  const suggestionCard = (s: SuggestionRow) => `<article class="card change ${s.kind}${s.decision ? ' decided' : ''}"><div class="card-head"><span class="avatar">${escape(initials(s.author))}</span>
    <button type="button" class="card-main" data-command="openSuggestion" data-path="${escape(s.path)}" data-value="${s.pos}" aria-label="${escape(s.author)}: ${s.kind === 'insert' ? 'Added' : 'Deleted'} ${escape(clip(s.text.replace(/\n/g, '⏎'), 120))}. Line ${s.line}. Open suggestion"><strong>${escape(s.author)}</strong><span class="meta">${escape(when(s.timestamp))}${when(s.timestamp) ? ' · ' : ''}<span class="chip">L${s.line}</span></span></button>${decideButton(s, 'accept')}${decideButton(s, 'reject')}</div>
    <button type="button" class="card-text" data-command="openSuggestion" data-path="${escape(s.path)}" data-value="${s.pos}" tabindex="-1">${suggestionText(s)}</button>
    ${s.decision ? `<div class="card-foot"><span class="badge pending">${s.decision === 'accept' ? 'Accept' : 'Reject'} on send</span></div>` : ''}</article>`;
  // A labelled switch: the editor highlights the selected review items, or none.
  const highlightSwitch = `<button type="button" class="switch" role="switch" data-command="toggleHighlights" aria-checked="${view.highlightComments !== false}" title="${view.highlightComments !== false ? 'Selected review items are highlighted in the editor. Click to hide the highlights.' : 'Review highlights are hidden in the editor. Click to show them.'}"${view.busy ? ' disabled' : ''}><span class="track" aria-hidden="true"><span class="thumb"></span></span>Highlights</button>`;
  // Accept or reject every suggestion in a file, or one author's; again to undo.
  const bulk = (path: string, suggestions: SuggestionRow[]) => {
    if (suggestions.length < 2) return '';
    const all = (decision: 'accept' | 'reject') => suggestions.every(s => s.decision === decision);
    const byAuthor = suggestionAuthors(suggestions).length > 1 ? small('decideAuthorChanges', 'By author…', { className: 'decide-author', attrs: `data-path="${escape(path)}"`, title: 'Accept or reject the suggestions of one author in this file' }) : '';
    return `<div class="bulk"><span class="meta">${plural(suggestions.length, 'suggestion')}</span>${small('acceptAllChanges', all('accept') ? 'Undo accept all' : 'Accept all', { className: 'decide-all accept', attrs: `data-path="${escape(path)}"` })}${small('rejectAllChanges', all('reject') ? 'Undo reject all' : 'Reject all', { className: 'decide-all reject', attrs: `data-path="${escape(path)}"` })}${byAuthor}</div>`;
  };
  type Item = { path: string; line: number; html: string; kinds: (keyof ReviewFilter)[] };
  const filter = view.reviewFilter ?? reviewFilterDefault;
  const all: Item[] = [...view.rows.map(row => ({ path: row.path, line: row.line || Number.MAX_SAFE_INTEGER, html: threadCard(row),
      kinds: [row.thread.resolved ? 'resolved' as const : 'open' as const, ...pending.has(row.thread.id) ? ['outgoing' as const] : []] })),
    ...(view.suggestionRows ?? []).map(s => ({ path: s.path, line: s.line, html: suggestionCard(s), kinds: ['suggestions' as const, ...s.decision ? ['outgoing' as const] : []] }))].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  const items = all.filter(item => item.kinds.some(kind => filter[kind]));
  const chip = (kind: keyof ReviewFilter, label: string) => `<button type="button" class="filter-chip" data-command="toggleReviewFilter" data-value="${kind}" aria-pressed="${filter[kind]}"${view.busy ? ' disabled' : ''}>${label}<span class="n">${all.filter(item => item.kinds.includes(kind)).length}</span></button>`;
  const chips = `<div class="filter-chips" role="group" aria-label="List">${chip('open', 'Open')}${chip('resolved', 'Resolved')}${chip('suggestions', 'Suggestions')}${chip('outgoing', 'Going out')}</div>`;
  const byPath = new Map<string, Item[]>();
  for (const item of items) { const group = byPath.get(item.path) ?? []; group.push(item); byPath.set(item.path, group); }
  const comments = `<section class="section" aria-label="Review">
    <div class="section-title review-bar">${counts}<span class="title-actions">${small('newComment', 'Comment', { icon: 'commentAdd', disabled: !view.activePath, title: 'Comment on the selected text' })}</span></div>
    <div class="filter-row"><div class="segmented" role="group" aria-label="Show">${action('toggleComments', 'Current file', { className: 'segment', attrs: `data-value="current" aria-pressed="${!view.allComments}"` })}${action('toggleComments', 'All files', { className: 'segment', attrs: `data-value="all" aria-pressed="${!!view.allComments}"` })}</div>${highlightSwitch}</div>${chips}
    ${[...byPath].map(([path, group]) => `${view.allComments || byPath.size > 1 ? `<div class="file-heading">${icon('file')}${escape(path)}</div>` : ''}${filter.suggestions ? bulk(path, (view.suggestionRows ?? []).filter(s => s.path === path)) : ''}${group.map(item => item.html).join('')}`).join('') || `<p class="muted">${!view.activePath && !view.allComments ? 'Open a source file or select All files.' : all.length ? 'Nothing matches the chosen kinds. Turn on another one above.' : 'No comments or suggestions in this view.'}</p>`}
  </section>`;
  const syncInfo = `<div class="sync-pane">
    <div class="freshness" role="status">${icon('clock')}<span>${escape(view.freshness ?? 'Remote state not checked')}${view.checkedAt ? `<br>${view.interval === 'live' ? 'Last update' : 'Last checked'} ` + escape(new Date(view.checkedAt).toLocaleTimeString()) : ''}</span></div>
    <div class="poll-controls"><label>Updates <select data-interval aria-label="Remote updates">${(['live', 10, 30, 60, 0] as const).map(n => `<option value="${n}"${(view.interval ?? 'live') === n ? ' selected' : ''}>${n === 'live' ? 'Live' : n ? `Every ${n} s` : 'Manually'}</option>`).join('')}</select></label>${surface === 'panel' ? compact('checkRemote', 'Check remote now', 'refresh') : ''}</div>
    <div class="footer-links">${small('showSyncHistory', 'Sync history', { icon: 'history' })}${small('openReviewFiles', 'Local review files', { icon: 'file', disabled: !view.linked })}${view.version ? `<span class="version" title="Turnleaf version">v${escape(view.version)}</span>` : ''}</div>
  </div>`;
  // The header and the outgoing summary stay above the tabs: what goes out is in view on every pass.
  const firstTab = configured ? 'review' : 'setup';
  const remoteTrouble = /unknown|lost/i.test(view.freshness ?? '');
  const tab = (id: string, label: string, glyph: Icon, note = '') => `<button type="button" class="tab" role="tab" id="tab-${id}" data-tab="${id}" aria-controls="pane-${id}" aria-selected="${id === firstTab}" tabindex="${id === firstTab ? 0 : -1}">${icon(glyph)}<span class="tab-label">${label}</span>${note}</button>`;
  const pane = (id: string, html: string) => `<div class="tab-pane" role="tabpanel" id="pane-${id}" aria-labelledby="tab-${id}" data-pane="${id}"${id === firstTab ? '' : ' hidden'}>${html}</div>`;
  const tabs = `<div class="tabs" role="tablist" aria-label="Overleaf views" data-configured="${configured}" data-first-tab="${firstTab}" data-show-preview="${escape(p?.id ?? '')}" data-show-thread="${escape(view.selectedThread ?? '')}">
    ${tab('review', 'Review', 'comment')}${tab('setup', 'Setup', 'settings')}${tab('sync', 'Sync', 'refresh', remoteTrouble ? `<span class="tab-dot" role="img" aria-label="${escape(view.freshness!)}" title="${escape(view.freshness!)}"></span>` : '')}
  </div>`;
  const main = `${header}${summary}${view.recovery && !(summary && o?.blocked?.way === 'recover') ? `<section class="section"><div class="notice"><p>A local update was interrupted. Your recovery checkpoint is retained.</p>${action('recoverLocalApply', 'Recover local apply')}</div></section>` : ''}${tabs}${pane('review', review + comments)}${pane('setup', setup)}${pane('sync', syncInfo)}`;
  if (surface === 'sidebar') return main;
  const d = view.detail;
  const detail = d ? `<div class="detail-head"><h2>${escape(d.row.path)} ${lineChip(d.row)}</h2><span class="title-actions">${badges(d.row)}${small(d.row.thread.resolved ? 'reopen' : 'resolve', d.row.thread.resolved ? 'Reopen on send' : 'Resolve on send', { icon: d.row.thread.resolved ? 'refresh' : 'check', attrs: `data-value="${escape(d.row.thread.id)}"` })}${small('openThread', 'Show in editor', { attrs: `data-value="${escape(d.row.thread.id)}"` })}</span></div>
    ${d.anchorText ? `<blockquote class="anchor-quote">${escape(clip(d.anchorText, 400))}</blockquote>` : goneText(d.row) ? `<blockquote class="anchor-quote gone">${escape(goneText(d.row))}</blockquote>` : ''}
    ${d.context.length ? `<pre class="context">${d.context.map(line => `<span class="${line.anchored ? 'anchored' : ''}"><span class="ln">${line.line}</span>${escape(line.text) || ' '}</span>`).join('')}</pre>` : ''}
    <ol class="messages">${d.row.thread.messages.map(message => `<li><span class="avatar">${escape(initials(message.author))}</span><div class="message-body"><div class="message-head"><strong>${escape(message.author)}</strong><span class="meta">${escape(when(message.timestamp))}</span><span class="push-right">${messageActions(d.row, message)}</span></div><p>${escape(message.text)}</p></div></li>`).join('')}</ol>
    ${replyBox(d.row.thread.id, 3)}`
    : '<div class="empty"><p>Select a comment to read the whole thread here.</p><p class="muted">Replies and resolutions are saved locally and listed as going out until Send.</p></div>';
  return `<div class="layout"><div class="main-col">${main}</div><aside class="detail-col" aria-label="Selected thread">${detail}</aside></div>`;
}
export function projectPanel(view: ProjectView, surface: Surface = 'sidebar'): string {
  const nonce = randomUUID();
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'"><style nonce="${nonce}">${panelStyle}${historyStyle}</style></head><body class="${surface}"><main id="project">${projectContent(view, surface)}</main><script nonce="${nonce}">
const api=acquireVsCodeApi();
const remembered=api.getState()||{};
// A list the user hid opens again once for each new reason to look (data-force), then follows the user's toggle.
function restoreDetails(){document.querySelectorAll('details[data-section]').forEach(d=>{const s=d.dataset.section,f=d.dataset.force;if(f!==undefined){if(f&&remembered['force:'+s]!==f)remembered[s]=true;remembered['force:'+s]=f;}if(s in remembered)d.open=remembered[s];});api.setState(remembered);}
restoreDetails();
// A first message cut to its lines offers Show more; the choice is kept per thread. Unfolding a
// card's replies shows its first message in full as well, and folding them cuts it again.
function fitTexts(){if(!document.body.classList.contains('sidebar'))return;document.querySelectorAll('[data-text-toggle]').forEach(b=>{const text=b.closest('.card')?.querySelector('.card-text');if(!text)return;const full=!!remembered['text:'+b.dataset.textToggle];text.classList.toggle('full',full);b.textContent=full?'Show less':'Show more';b.setAttribute('aria-expanded',full);b.hidden=!full&&text.scrollHeight<=text.clientHeight+1;});}
function toggleText(id,full){remembered['text:'+id]=full;api.setState(remembered);fitTexts();}
window.addEventListener('resize',fitTexts);document.fonts?.ready.then(fitTexts);
// The chosen view is kept separately for set-up and not-yet-set-up projects, so finishing setup opens Review.
const tabScroll={};
function tabBar(){return document.querySelector('.tabs');}
function tabKey(bar){return 'tab:'+bar.dataset.configured;}
function showTab(id,focus){document.querySelectorAll('[data-tab]').forEach(t=>{const on=t.dataset.tab===id;t.setAttribute('aria-selected',on);t.tabIndex=on?0:-1;if(on&&focus)t.focus();});document.querySelectorAll('[data-pane]').forEach(p=>{p.hidden=p.dataset.pane!==id;});fitTexts();}
function selectTab(id,focus){const bar=tabBar();if(!bar)return;const key=tabKey(bar);tabScroll[remembered[key]||bar.dataset.firstTab]=window.scrollY;remembered[key]=id;api.setState(remembered);showTab(id,focus);window.scrollTo(0,tabScroll[id]||0);}
// A new preview or a thread opened from the editor is shown in Review, whichever view is open.
function restoreTab(){const bar=tabBar();if(!bar)return;const key=tabKey(bar),preview=bar.dataset.showPreview,thread=bar.dataset.showThread;if((preview&&preview!==remembered.seenPreview)||(thread&&thread!==remembered.seenThread))remembered[key]='review';remembered.seenPreview=preview;remembered.seenThread=thread;api.setState(remembered);showTab(remembered[key]||bar.dataset.firstTab);}
restoreTab();
function reply(id,press){const box=document.querySelector('textarea[data-reply="'+CSS.escape(id)+'"]'),text=box?.value.trim();if(!text){box?.focus();return;}if(text.length>20000){box.setCustomValidity('Keep replies under 20,000 characters.');box.reportValidity();return;}api.postMessage({command:'reply',value:id,text,press});box.value='';}
// The press record: a press on a button that reaches the extension is reported on pointerdown, before any
// filtering, so a press on a disabled button, an extra click of a double click and a click lost in a redraw
// are recorded too. detail counts presses on the same button within 500 ms, except that a press on it while it
// was disabled does not count toward the next press once it is enabled (a retry, not a double click). A render
// that arrives while a button is held waits until it is released (at most 1 s), so the click lands on the button
// that was pressed. Numbers start at random, so a reloaded view does not reuse the numbers of the one before.
let pressSeq=Math.floor(Math.random()*1e9),pressed,released,lastPress,heldHtml,holdTimer;
const pressKey=b=>[b.dataset.command||'',b.dataset.id||'',b.dataset.path||'',b.dataset.value||'',b.dataset.message||'',b.dataset.preview||''].join('|');
document.addEventListener('pointerdown',e=>{if(e.button!==0)return;const b=e.target.closest?.('button'),command=b&&(b.dataset.command||(b.dataset.id?'openThread':''));if(!command)return;const now=Date.now(),key=pressKey(b),near=lastPress&&lastPress.key===key&&now-lastPress.at<500,retry=!!near&&lastPress.disabled&&!b.disabled,count=near&&!retry?lastPress.count+1:1;lastPress={key,at:now,count,disabled:b.disabled};pressed={b,seq:++pressSeq,count,at:now,retry};api.postMessage({type:'press',seq:pressed.seq,command,disabled:b.disabled,detail:count});clearTimeout(holdTimer);holdTimer=setTimeout(flush,1000);},true);
function release(){if(!pressed)return;released=pressed;pressed=undefined;api.postMessage({type:'release',seq:released.seq,lost:!released.b.isConnected});setTimeout(flush,0);}
document.addEventListener('pointerup',release,true);document.addEventListener('pointercancel',release,true);
function flush(){clearTimeout(holdTimer);const held=pressed&&Date.now()-pressed.at;if(held<1000){holdTimer=setTimeout(flush,1000-held);return;}const html=heldHtml;heldHtml=undefined;if(html!==undefined)render(html);}
document.addEventListener('toggle',e=>{if(e.target.matches('details[data-section]')){remembered[e.target.dataset.section]=e.target.open;api.setState(remembered);}},true);
document.addEventListener('click',e=>{const replies=e.target.closest('.card-replies>summary')?.parentElement;if(replies)toggleText(replies.dataset.section.slice(8),!replies.open);const b=e.target.closest('button');if(b&&b.closest('summary'))e.preventDefault();const p=released&&b&&released.b===b?released:undefined;released=undefined;if(p&&!p.retry&&(e.detail>1||p.count>1)){api.postMessage({type:'click-extra',seq:p.seq});return;}if(!b||b.disabled||e.detail>1&&!p?.retry)return;const press=p?.seq;if(b.dataset.textToggle)toggleText(b.dataset.textToggle,b.getAttribute('aria-expanded')!=='true');else if(b.dataset.tab)selectTab(b.dataset.tab);else if(b.dataset.command==='reply')reply(b.dataset.value,press);else if(b.dataset.command)api.postMessage({command:b.dataset.command,path:b.dataset.path,preview:b.dataset.preview,value:b.dataset.value,message:b.dataset.message,revision:b.dataset.revision,press});else if(b.dataset.id)api.postMessage({id:b.dataset.id,press});});
document.addEventListener('keydown',e=>{const t=e.target;if(t.matches?.('[data-tab]')&&(e.key==='ArrowLeft'||e.key==='ArrowRight')){const all=[...document.querySelectorAll('[data-tab]')];e.preventDefault();selectTab(all[(all.indexOf(t)+(e.key==='ArrowRight'?1:all.length-1))%all.length].dataset.tab,true);return;}if(t.matches?.('textarea[data-reply]')&&e.key==='Enter'&&(e.metaKey||e.ctrlKey)){e.preventDefault();reply(t.dataset.reply);}});
document.addEventListener('input',e=>{if(e.target.matches('textarea[data-reply]'))e.target.setCustomValidity('');});
document.addEventListener('change',e=>{if(e.target.matches('[data-interval]'))api.postMessage({command:'setCheckInterval',value:e.target.value==='live'?'live':Number(e.target.value)});});
window.addEventListener('message',e=>{
 if(e.data?.type!=='render')return;
 if(pressed&&Date.now()-pressed.at<1000){heldHtml=e.data.html;return;}
 heldHtml=undefined;render(e.data.html);
});
function render(html){
 const focused=document.hasFocus(),active=document.activeElement,textToggle=active?.dataset?.textToggle,key=active?.dataset?.command,id=active?.dataset?.id,path=active?.dataset?.path,value=active?.dataset?.value,interval=active?.hasAttribute('data-interval'),activeTab=active?.dataset?.tab,section=active?.tagName==='SUMMARY'?active.parentElement?.dataset?.section:undefined,scroll=window.scrollY,detailScroll=document.querySelector('.detail-col')?.scrollTop;
 // Unsent reply text, its caret and focus survive re-rendering.
 const typed=[...document.querySelectorAll('textarea[data-reply]')].filter(t=>t.value).map(t=>({id:t.dataset.reply,value:t.value,active:t===active,start:t.selectionStart,end:t.selectionEnd,rows:t.rows}));
 document.getElementById('project').innerHTML=html;restoreDetails();restoreTab();
 for(const t of typed){const box=document.querySelector('textarea[data-reply="'+CSS.escape(t.id)+'"]');if(!box)continue;box.value=t.value;if(t.active&&focused){box.focus({preventScroll:true});box.setSelectionRange(t.start,t.end);}}
 const detail=document.querySelector('.detail-col');if(detail&&detailScroll!==undefined)detail.scrollTop=detailScroll;
 if(typed.some(t=>t.active))return window.scrollTo(0,scroll);
 const next=textToggle?document.querySelector('[data-text-toggle="'+CSS.escape(textToggle)+'"]'):activeTab?document.querySelector('[data-tab="'+activeTab+'"]'):section?[...document.querySelectorAll('details[data-section]')].find(d=>d.dataset.section===section)?.querySelector('summary'):interval?document.querySelector('[data-interval]'):[...document.querySelectorAll('button')].find(b=>id?b.dataset.id===id:key&&b.dataset.command===key&&b.dataset.path===path&&b.dataset.value===value);
 if(focused)next?.focus({preventScroll:true});window.scrollTo(0,scroll);
}
api.postMessage({ready:true});
</script></body></html>`;
}
