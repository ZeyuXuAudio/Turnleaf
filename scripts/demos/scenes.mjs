// Scripted feature demos. The sidebar is the extension's own panel renderer, and
// everything it shows comes from the extension's code: the state line and status bar
// (src/extension/syncText.ts), outgoing and undo rows (outgoingComments), line counts
// (diffText + changedLines), diff tab titles and comment notes, and the review thread
// file (recordFor). The VS Code chrome around it is drawn in vscodeChrome.mjs.
// test/demoScenes.test.ts checks the scenes against the extension.
import {
  renderCodeEditor,
  renderDiffEditor,
  renderSplitAgentEditor,
  renderStatusText,
  renderTabBar,
} from './vscodeChrome.mjs';

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function interpolateCursor(waypoints, t) {
  if (t <= waypoints[0].t) return { x: waypoints[0].x, y: waypoints[0].y };
  for (let i = 1; i < waypoints.length; i++) {
    const prev = waypoints[i - 1];
    const curr = waypoints[i];
    if (t <= curr.t) {
      const u = easeInOutCubic(clamp01((t - prev.t) / Math.max(0.0001, curr.t - prev.t)));
      return { x: prev.x + (curr.x - prev.x) * u, y: prev.y + (curr.y - prev.y) * u };
    }
  }
  const last = waypoints[waypoints.length - 1];
  return { x: last.x, y: last.y };
}

const RIPPLE = 0.35;
/** Cursor press, the pressed control and the ripple of each click. */
function clickEffects(t, clicks) {
  const fx = { pressing: false, pressSelector: null, ripple: 0, rippleX: 0, rippleY: 0 };
  for (const c of clicks) {
    if (t >= c.t - 0.1 && t <= c.t + 0.08) { fx.pressing = true; fx.pressSelector = c.selector ?? null; }
    if (t >= c.t && t <= c.t + RIPPLE) { fx.ripple = (t - c.t) / RIPPLE; fx.rippleX = c.x; fx.rippleY = c.y; }
  }
  return fx;
}

/** An outline that fades in and out on what a click changed. */
function flashAt(t, flashes) {
  for (const f of flashes) {
    const d = f.duration ?? 1.1;
    if (t >= f.t && t <= f.t + d) {
      const u = (t - f.t) / d;
      return { flashSelector: f.selector, flash: Number((u < 0.2 ? u / 0.2 : 1 - (u - 0.2) / 0.8).toFixed(2)) };
    }
  }
  return { flashSelector: null, flash: 0 };
}

/** The measured centre of a click target; a missing target stops the render. */
function target(byState, state, selector) {
  const point = byState[state]?.[selector];
  if (!point) throw new Error(`Demo target ${selector} is missing in state ${state}. Did the panel markup change?`);
  return point;
}

function stepAt(t, steps) {
  let current = steps[0];
  for (const s of steps) if (t >= s.t) current = s;
  return current;
}

// A fixed clock, so the comment widget's relative times stay the same in every render.
const NOW = Date.parse('2026-11-18T14:30:00');
function fromNow(iso) {
  const mins = Math.round((NOW - Date.parse(iso)) / 60000);
  return mins < 1 ? 'now' : mins === 1 ? '1 min ago' : `${mins} mins ago`;
}

const PATH = 'sections/method.tex';
const DOC_ID = 'doc-method';
const ME = { name: 'Alex Chen', id: 'u-alex' };

const baseView = {
  name: 'Spatial Audio Paper',
  server: 'https://www.overleaf.com',
  files: ['main.tex', PATH],
  writes: true,
  connected: true,
  linked: true,
  activePath: PATH,
  userId: ME.id,
  reviews: {},
  allComments: false,
  live: true,
  interval: 'live',
};

const lines = (text) => text.split('\n');
const join = (rows) => rows.join('\n');

/** The projection Overleaf gives the extension, for one file. */
function inspectionOf({ text, threads = [], anchors = {}, changes = [] }) {
  return {
    projectId: 'demo-project',
    projectName: baseView.name,
    fetchedAt: '2026-11-18T14:30:00',
    userId: ME.id,
    missingFiles: [],
    unassignedThreadCount: 0,
    docs: [{
      path: PATH, docId: DOC_ID, otType: 'history-ot', version: 1, text, diagnostics: [], changes,
      comments: Object.entries(anchors).map(([threadId, quoted]) => {
        const pos = text.indexOf(quoted);
        if (pos < 0) throw new Error(`Anchor "${quoted}" not in the demo text.`);
        return { threadId, ranges: [{ pos, length: quoted.length }], state: 'placed' };
      }),
    }],
    threads: Object.fromEntries(threads.map((thread) => [thread.id, thread])),
  };
}

const lineOf = (text, quoted) => text.slice(0, text.indexOf(quoted)).split('\n').length;

/** A sidebar card row for a thread anchored on `quoted`. */
function rowOf(text, thread, quoted) {
  const pos = text.indexOf(quoted);
  return { path: PATH, docId: DOC_ID, line: lineOf(text, quoted), excerpt: quoted, anchor: { label: 'unchanged', ranges: [{ pos, length: quoted.length }] }, thread };
}

let draftCount = 0;
function draft(kind, threadId, extra = {}) {
  draftCount++;
  return { id: `draft-${draftCount}`, kind, path: PATH, docId: DOC_ID, threadId, created: '2026-11-18T14:2' + (draftCount % 10) + ':00', ...extra };
}
/** The sidebar's draft list entry for a stored draft, as the extension's view() builds it. */
const draftView = (d) => ({ id: d.id, kind: d.kind, path: d.path, threadId: d.threadId, ...(d.text !== undefined && { text: d.text }), ...(d.change && { suggestion: { kind: d.change.kind, text: d.change.text } }) });

export function createScenes(ui) {
  const { projectContent, text: T, outgoingComments, recordFor, diffText, changedLines } = ui;

  const counts = (before, after) => changedLines(diffText(before, after).diffs);
  const sidebar = (view) => projectContent({ ...baseView, ...view }, 'sidebar');
  const status = (input) => renderStatusText(T.statusText({ session: 'valid', inspected: true, freshness: T.FRESHNESS.live, open: 1, suggestions: 0, unsent: 0, ...input }));
  const state = (input) => T.stateLabel({ session: 'valid', inspected: true, serviceReady: true, ...input });

  /**
   * A side-by-side diff of two texts: equal lines aligned, removed and added runs
   * paired line by line with the changed characters marked, the shorter run padded.
   * `notes` puts the extension's comment note after a line of the right side.
   */
  function diffSidesOf(before, after, notes = {}) {
    const a = lines(before), b = lines(after);
    const lcs = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    const left = [], right = [];
    let i = 0, j = 0;
    const flush = (removed, added) => {
      for (let k = 0; k < Math.max(removed.length, added.length); k++) {
        const r = removed[k], s = added[k];
        let rs = [], as = [];
        if (r && s) {
          let ra = 0, aa = 0;
          for (const [kind, piece] of diffText(r.text, s.text).diffs) {
            if (kind === -1) { rs.push({ start: ra, end: ra + piece.length }); ra += piece.length; }
            else if (kind === 1) { as.push({ start: aa, end: aa + piece.length }); aa += piece.length; }
            else { ra += piece.length; aa += piece.length; }
          }
        }
        left.push(r ? { ln: r.ln, text: r.text, kind: 'removed', spans: rs } : { kind: 'blank' });
        right.push(s ? { ln: s.ln, text: s.text, kind: 'added', spans: as, note: notes[s.ln] } : { kind: 'blank' });
      }
    };
    let removed = [], added = [];
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        flush(removed, added); removed = []; added = [];
        left.push({ ln: i + 1, text: a[i] });
        right.push({ ln: j + 1, text: b[j], note: notes[j + 1] });
        i++; j++;
      } else if (j < b.length && (i >= a.length || lcs[i][j + 1] >= lcs[i + 1][j])) { added.push({ ln: j + 1, text: b[j] }); j++; }
      else { removed.push({ ln: i + 1, text: a[i] }); i++; }
    }
    flush(removed, added);
    return { leftLines: left, rightLines: right };
  }
  const changedLineNumbers = (before, after) => diffSidesOf(before, after).rightLines.filter((l) => l.kind === 'added').map((l) => l.ln);

  // -------------------------------------------------------------------------
  // 1. Get latest: a merge preview, then Apply
  // -------------------------------------------------------------------------
  const glLocal = join([
    '\\section{Signal Model}',
    '\\label{sec:method}',
    '',
    'We model the microphone array response',
    'using short-time Fourier frames $X_{m}(f)$.',
    '',
    '\\begin{equation}',
    '  y_m(t) = h_m * x(t)',
    '\\end{equation}',
    '',
    'Each frame uses a 512-sample Hann window.',
    'The steering vector $\\mathbf{a}(\\theta)$',
    'is normalized to unit Euclidean norm.',
    '% Local draft: verify array geometry',
  ]);
  // Overleaf changed lines 4 and 11; the local draft line is kept by the merge.
  const glMerged = join([
    '\\section{Signal Model}',
    '\\label{sec:method}',
    '',
    'We model the 48\\,kHz microphone array response',
    'using short-time Fourier frames $X_{m}(f)$.',
    '',
    '\\begin{equation}',
    '  y_m(t) = h_m * x(t)',
    '\\end{equation}',
    '',
    'Each frame uses a 512-sample Hann window',
    'with 50\\% overlap between adjacent frames.',
    'The steering vector $\\mathbf{a}(\\theta)$',
    'is normalized to unit Euclidean norm.',
    '% Local draft: verify array geometry',
  ]);
  const glThread = {
    id: 't-1', resolved: false,
    messages: [{ id: 'm-1', author: 'Hannah Lin', authorId: 'u-hannah', timestamp: '2026-11-18T14:10:00', text: 'Should we state the sampling rate here?' }],
  };
  const glThreadAfter = {
    ...glThread,
    messages: [...glThread.messages, { id: 'm-2', author: 'David Park', authorId: 'u-david', timestamp: '2026-11-18T14:21:00', text: 'Added 48 kHz to the first sentence.' }],
  };
  const glAnchor = 'x(t)';
  // The pull plan's comment change for a thread with a new message (folderWorkflow.ts).
  const glComment = { id: 't-1', threadId: 't-1', path: PATH, label: 'Updated thread', line: lineOf(glMerged, glAnchor), before: glThread, after: glThreadAfter };
  const glCounts = counts(glLocal, glMerged);
  const glNote = `💬 ${T.commentNote(glComment, true)}`;
  const glTitle = T.diffTabTitle(PATH, 'merge');
  const glFlash = changedLineNumbers(glLocal, glMerged);

  const getLatestScene = {
    id: 'get-latest',
    title: 'Get latest with merge preview',
    fps: 15,
    duration: 6.8,
    targetSelectors: ['button[data-command="pull"]', 'button[data-command="applyReviewed"]'],
    states: [
      {
        sidebarHtml: sidebar({
          state: state({ needsPull: true }),
          freshness: T.FRESHNESS.incoming,
          openComments: 1, suggestions: 0,
          rows: [rowOf(glLocal, glThread, glAnchor)],
        }),
        tabsHtml: renderTabBar([{ title: 'method.tex', file: PATH, active: true }]),
        editorHtml: renderCodeEditor({ lines: lines(glLocal), commentHighlights: { [lineOf(glLocal, glAnchor)]: glAnchor }, gutterComments: { [lineOf(glLocal, glAnchor)]: 'open' }, activeLine: 14 }),
        statusHtml: status({ needsPull: true, freshness: T.FRESHNESS.incoming }),
        cursorText: 'Ln 14, Col 37',
      },
      {
        sidebarHtml: sidebar({
          state: state({ needsPull: true, preview: {} }),
          freshness: T.FRESHNESS.incoming,
          openComments: 1, suggestions: 0,
          preview: { id: 'preview-1', selectedPath: PATH, files: [{ path: PATH, ...glCounts }], comments: [glComment] },
          rows: [rowOf(glLocal, glThread, glAnchor)],
        }),
        tabsHtml: renderTabBar([{ title: 'method.tex', file: PATH }, { title: glTitle, file: PATH, active: true, preview: true }]),
        editorHtml: renderDiffEditor(diffSidesOf(glLocal, glMerged, { [lineOf(glMerged, glAnchor)]: glNote })),
        statusHtml: status({ needsPull: true, preview: {}, freshness: T.FRESHNESS.incoming }),
        cursorText: 'Ln 4, Col 1',
      },
      {
        sidebarHtml: sidebar({
          state: state({ preview: { complete: T.LOCAL_APPLIED }, note: 'Local updates applied' }),
          openComments: 1, suggestions: 0,
          rows: [rowOf(glMerged, glThreadAfter, glAnchor)],
        }),
        tabsHtml: renderTabBar([{ title: 'method.tex', file: PATH, active: true }]),
        editorHtml: renderCodeEditor({ lines: lines(glMerged), commentHighlights: { [lineOf(glMerged, glAnchor)]: glAnchor }, gutterComments: { [lineOf(glMerged, glAnchor)]: 'open' }, flashLines: glFlash, activeLine: 15 }),
        statusHtml: status({ preview: { complete: T.LOCAL_APPLIED }, note: 'Local updates applied' }),
        cursorText: 'Ln 15, Col 37',
      },
    ],
    timeline(t, byState) {
      const pull = target(byState, 0, 'button[data-command="pull"]');
      const apply = target(byState, 1, 'button[data-command="applyReviewed"]');
      const pos = interpolateCursor([
        { t: 0, x: 560, y: 330 },
        { t: 0.3, x: 560, y: 330 },
        { t: 1.05, x: pull.x, y: pull.y },
        { t: 1.65, x: pull.x, y: pull.y },
        { t: 2.4, x: 790, y: 210 },
        { t: 3.5, x: 790, y: 230 },
        { t: 4.2, x: apply.x, y: apply.y },
        { t: 4.8, x: apply.x, y: apply.y },
        { t: 5.5, x: 600, y: 420 },
      ], t);
      const fx = clickEffects(t, [
        { t: 1.3, x: pull.x, y: pull.y, selector: 'button[data-command="pull"]' },
        { t: 4.45, x: apply.x, y: apply.y, selector: 'button[data-command="applyReviewed"]' },
      ]);
      const step = stepAt(t, [
        { t: 0, stateIndex: 0, stepLabel: '1 / 3', caption: 'Overleaf has new edits' },
        { t: 1.42, stateIndex: 1, stepLabel: '2 / 3', caption: 'Get latest: review the merge before files change' },
        { t: 4.57, stateIndex: 2, stepLabel: '3 / 3', caption: 'Apply: Overleaf edits merged, local edits kept' },
      ]);
      const hoverSelector = t >= 0.95 && t < 1.42 ? 'button[data-command="pull"]' : t >= 4.1 && t < 4.57 ? 'button[data-command="applyReviewed"]' : null;
      return { ...step, hoverSelector, ...pos, ...fx, ...flashAt(t, [{ t: 4.6, selector: '#turnleaf-sidebar .status', duration: 1.3 }]) };
    },
  };

  // -------------------------------------------------------------------------
  // 2. Comments and suggestions in the editor
  // -------------------------------------------------------------------------
  const csText = join([
    '\\section{Signal Model}',
    '\\label{sec:method}',
    '',
    'The input signal $x(t)$ is sampled at 48\\,kHz',
    'and framed with a 512-sample Hann window.',
    '',
    'We capture multi-channel room impulse responses',
    'under controlled reverberation ($T_{60} = 0.45\\,$s).',
    '\\begin{equation}',
    '  y_m(t) = h_m * x(t)',
    '\\end{equation}',
  ]);
  const csAnchor = 'is sampled';
  const csInsert = 'at 48\\,kHz';
  const csThread = {
    id: 't-1', resolved: false,
    messages: [{ id: 'm-1', author: 'Hannah Lin', authorId: 'u-hannah', timestamp: '2026-11-18T14:10:00', text: 'Should we state the sampling rate here?' }],
  };
  const csSuggestion = { id: 's-1', kind: 'insert', pos: csText.indexOf(csInsert), text: csInsert, author: 'David Park', authorId: 'u-david', timestamp: '2026-11-18T14:15:00' };
  const csInspection = inspectionOf({ text: csText, threads: [csThread], anchors: { 't-1': csAnchor }, changes: [csSuggestion] });
  const csReplyText = 'David\'s suggestion adds it, accepting that.';
  const csReply = draft('reply', 't-1', { text: csReplyText });
  const csAccept = draft('acceptChange', 's-1', { change: { ...csSuggestion } });
  const csLine = lineOf(csText, csAnchor);
  const csSuggestionRow = (decision) => ({ id: 's-1', path: PATH, line: lineOf(csText, csInsert), pos: csSuggestion.pos, kind: 'insert', text: csInsert, author: 'David Park', timestamp: csSuggestion.timestamp, ...(decision && { decision }) });
  const csEditor = (thread, extra = {}) => renderCodeEditor({
    lines: lines(csText),
    commentHighlights: { [csLine]: csAnchor },
    gutterComments: { [csLine]: 'open' },
    // The suggested insertion stays highlighted until Send; only its hover changes.
    suggestions: { [lineOf(csText, csInsert)]: csInsert },
    activeLine: csLine,
    inlineThread: thread,
    ...extra,
  });
  const hannahMessage = { author: 'Hannah Lin', time: fromNow(csThread.messages[0].timestamp), text: csThread.messages[0].text };
  // A draft reply shows in the thread with the comment label Pending send (workspace.ts).
  const pendingReply = { author: ME.name, time: fromNow('2026-11-18T14:29:00'), text: csReplyText, label: 'Pending send' };
  const csCommon = { openComments: 1, suggestions: 1, rows: [rowOf(csText, csThread, csAnchor)] };
  const csStatus = (unsent) => status({ suggestions: 1, unsent });
  const csOutgoing = (drafts) => ({ files: [], comments: outgoingComments(csInspection, drafts), check: { mode: 'full', live: true } });

  const commentsScene = {
    id: 'comments-suggestions',
    title: 'Comments and suggestions in the editor',
    fps: 15,
    duration: 7.4,
    targetSelectors: ['button[data-id="t-1"]', '[data-demo-target="inline-reply-btn"]', 'button[data-command="acceptChange"]'],
    states: [
      {
        sidebarHtml: sidebar({ state: state({}), ...csCommon, suggestionRows: [csSuggestionRow()] }),
        tabsHtml: renderTabBar([{ title: 'method.tex', file: PATH, active: true }]),
        editorHtml: csEditor(null),
        statusHtml: csStatus(0),
        cursorText: `Ln ${csLine}, Col 1`,
      },
      {
        sidebarHtml: sidebar({ state: state({}), ...csCommon, selectedThread: 't-1', suggestionRows: [csSuggestionRow()] }),
        tabsHtml: renderTabBar([{ title: 'method.tex', file: PATH, active: true }]),
        editorHtml: csEditor({ afterLine: csLine, messages: [hannahMessage], showReplyBox: true, typedText: '', typingFocused: true, caretActive: true }),
        statusHtml: csStatus(0),
        cursorText: `Ln ${csLine}, Col 1`,
      },
      {
        sidebarHtml: sidebar({
          state: state({ standing: { files: 0, comments: 1 } }), ...csCommon, selectedThread: 't-1',
          drafts: [draftView(csReply)], outgoing: csOutgoing([csReply]), suggestionRows: [csSuggestionRow()],
        }),
        tabsHtml: renderTabBar([{ title: 'method.tex', file: PATH, active: true }]),
        editorHtml: csEditor({ afterLine: csLine, label: 'Pending send', messages: [hannahMessage, pendingReply], showReplyBox: false }),
        statusHtml: csStatus(1),
        cursorText: `Ln ${csLine}, Col 1`,
      },
      {
        sidebarHtml: sidebar({
          state: state({ standing: { files: 0, comments: 2 } }), ...csCommon, selectedThread: 't-1',
          drafts: [draftView(csReply), draftView(csAccept)], outgoing: csOutgoing([csReply, csAccept]), suggestionRows: [csSuggestionRow('accept')],
        }),
        tabsHtml: renderTabBar([{ title: 'method.tex', file: PATH, active: true }]),
        editorHtml: csEditor({ afterLine: csLine, label: 'Pending send', messages: [hannahMessage, pendingReply], showReplyBox: false }),
        statusHtml: csStatus(2),
        cursorText: `Ln ${csLine}, Col 1`,
      },
    ],
    timeline(t, byState) {
      const card = target(byState, 0, 'button[data-id="t-1"]');
      const reply = target(byState, 1, '[data-demo-target="inline-reply-btn"]');
      const accept = target(byState, 2, 'button[data-command="acceptChange"]');
      const pos = interpolateCursor([
        { t: 0, x: 640, y: 300 },
        { t: 0.3, x: 640, y: 300 },
        { t: 0.95, x: card.x, y: card.y },
        { t: 1.5, x: card.x, y: card.y },
        { t: 2.0, x: reply.x - 220, y: reply.y - 40 },
        { t: 3.5, x: reply.x - 200, y: reply.y - 36 },
        { t: 3.95, x: reply.x, y: reply.y },
        { t: 4.45, x: reply.x, y: reply.y },
        { t: 5.05, x: accept.x, y: accept.y },
        { t: 5.7, x: accept.x, y: accept.y },
        { t: 6.4, x: accept.x + 60, y: accept.y + 70 },
      ], t);
      const fx = clickEffects(t, [
        { t: 1.15, x: card.x, y: card.y, selector: 'button[data-id="t-1"]' },
        { t: 4.1, x: reply.x, y: reply.y, selector: '[data-demo-target="inline-reply-btn"]' },
        { t: 5.35, x: accept.x, y: accept.y, selector: 'button[data-command="acceptChange"]' },
      ]);
      const step = stepAt(t, [
        { t: 0, stateIndex: 0, stepLabel: '1 / 3', caption: 'Open an Overleaf comment in the editor' },
        { t: 1.25, stateIndex: 1, stepLabel: '2 / 3', caption: 'Reply: saved as a draft, sent only with Send' },
        { t: 4.2, stateIndex: 2, stepLabel: '2 / 3', caption: 'Reply: saved as a draft, sent only with Send' },
        { t: 5.45, stateIndex: 3, stepLabel: '3 / 3', caption: 'Accept a suggestion: it waits for Send too' },
      ]);
      const typeProgress = clamp01((t - 1.6) / 1.7);
      const typing = step.stateIndex === 1 ? {
        typedText: csReplyText.slice(0, Math.round(typeProgress * csReplyText.length)),
        caretOn: t < 3.5 || Math.floor(t * 2.5) % 2 === 0,
        inputFocused: true,
      } : {};
      const hoverSelector = t >= 0.85 && t < 1.25 ? 'button[data-id="t-1"]'
        : t >= 3.85 && t < 4.2 ? '[data-demo-target="inline-reply-btn"]'
          : t >= 4.95 && t < 5.45 ? 'button[data-command="acceptChange"]' : null;
      const flash = flashAt(t, [
        { t: 4.25, selector: '#turnleaf-sidebar .outgoing-summary', duration: 0.9 },
        { t: 5.5, selector: '#turnleaf-sidebar .card.change', duration: 1.2 },
      ]);
      return { ...step, hoverSelector, ...typing, ...pos, ...fx, ...flash };
    },
  };

  // -------------------------------------------------------------------------
  // 3. Checked Send, then Undo this send
  // -------------------------------------------------------------------------
  const suOverleaf = join([
    '\\section{Signal Model}',
    '\\label{sec:method}',
    '',
    'We capture room impulse responses.',
    '\\begin{equation}',
    '  y_m(t) = h_m * x(t) + n_m(t)',
    '\\end{equation}',
    '',
    'Each frame uses a 512-sample Hann window.',
  ]);
  const suLocal = join([
    '\\section{Signal Model}',
    '\\label{sec:method}',
    '',
    'We capture 48\\,kHz impulse responses',
    'across 16 calibrated microphone capsules.',
    '\\begin{equation}',
    '  y_m(t) = h_m * x(t) + n_m(t)',
    '\\end{equation}',
    '',
    'Each frame uses a 512-sample Hann window.',
  ]);
  const suAnchor = 'n_m(t)';
  const suThread = {
    id: 't-1', resolved: false,
    messages: [{ id: 'm-1', author: 'Hannah Lin', authorId: 'u-hannah', timestamp: '2026-11-18T14:10:00', text: 'Which microphones and sampling rate?' }],
  };
  const suReplyText = 'Clarified: 48 kHz, 16 capsules.';
  const suBefore = inspectionOf({ text: suOverleaf, threads: [suThread], anchors: { 't-1': suAnchor } });
  const suDrafts = [draft('reply', 't-1', { text: suReplyText }), draft('resolve', 't-1')];
  const suOutgoing = outgoingComments(suBefore, suDrafts);
  // On Overleaf after the send: the reply (written by Alex) and the resolved thread.
  const suSentThread = { ...suThread, resolved: true, messages: [...suThread.messages, { id: 'm-9', author: ME.name, authorId: ME.id, timestamp: '2026-11-18T14:30:00', text: suReplyText }] };
  const suAfter = inspectionOf({ text: suLocal, threads: [suSentThread], anchors: { 't-1': suAnchor } });
  // Undo takes a send back last first: reopen the thread, then delete the reply (folderWorkflow.ts).
  const suUndo = outgoingComments(suAfter, [draft('reopen', 't-1'), draft('deleteMessage', 't-1', { messageId: 'm-9' })]);
  const suSendCounts = counts(suOverleaf, suLocal);
  const suUndoCounts = counts(suLocal, suOverleaf);
  const suFile = { path: PATH, ...suSendCounts };
  const suCheck = { mode: 'full', live: true };
  const suUnsent = { files: 1, comments: suOutgoing.length };
  const suRows = (thread, text) => [rowOf(text, thread, suAnchor)];
  const suUndoView = (busy) => ({ record: 'send-1', time: '2026-11-18T14:30:00', busy, selectedPath: `undo:${PATH}`, files: [{ path: PATH, ...suUndoCounts }], comments: suUndo, stays: [] });
  const suSourceEditor = renderCodeEditor({ lines: lines(suLocal), commentHighlights: { [lineOf(suLocal, suAnchor)]: suAnchor }, gutterComments: { [lineOf(suLocal, suAnchor)]: 'resolved' }, activeLine: 5 });

  const sendAndUndoScene = {
    id: 'send-and-undo',
    title: 'Checked Send and Undo this send',
    fps: 15,
    duration: 8.9,
    targetSelectors: ['button[data-command="send"]', 'button[data-command="undoSend"]', 'button[data-command="sendUndo"]'],
    states: [
      {
        sidebarHtml: sidebar({
          state: state({ standing: suUnsent }), openComments: 1, suggestions: 0,
          drafts: suDrafts.map(draftView),
          outgoing: { files: [suFile], comments: suOutgoing, selectedPath: PATH, check: suCheck },
          rows: suRows(suThread, suLocal),
        }),
        tabsHtml: renderTabBar([{ title: 'method.tex', file: PATH }, { title: T.diffTabTitle(PATH, 'send'), file: PATH, active: true, preview: true }]),
        editorHtml: renderDiffEditor(diffSidesOf(suOverleaf, suLocal)),
        statusHtml: status({ unsent: 3 }),
        cursorText: 'Ln 4, Col 1',
      },
      {
        // While sending, the summary and buttons are only greyed (workspace.ts).
        sidebarHtml: sidebar({
          busy: true, state: state({ standing: suUnsent }), openComments: 1, suggestions: 0,
          drafts: suDrafts.map(draftView),
          outgoing: { busy: true, files: [suFile], comments: suOutgoing, selectedPath: PATH, check: suCheck },
          rows: suRows(suThread, suLocal),
        }),
        tabsHtml: renderTabBar([{ title: 'method.tex', file: PATH }, { title: T.diffTabTitle(PATH, 'send'), file: PATH, active: true, preview: true }]),
        editorHtml: renderDiffEditor(diffSidesOf(suOverleaf, suLocal)),
        statusHtml: status({ unsent: 3 }),
        cursorText: 'Ln 4, Col 1',
      },
      {
        sidebarHtml: sidebar({
          state: state({ note: T.SENT_VERIFIED }), undoLatest: 'send-1', openComments: 0, suggestions: 0,
          rows: suRows(suSentThread, suLocal),
        }),
        tabsHtml: renderTabBar([{ title: 'method.tex', file: PATH, active: true }]),
        editorHtml: suSourceEditor,
        statusHtml: status({ open: 0, note: T.SENT_VERIFIED }),
        cursorText: 'Ln 5, Col 1',
      },
      {
        sidebarHtml: sidebar({
          state: state({ undo: {} }), openComments: 0, suggestions: 0,
          undo: suUndoView(false),
          rows: suRows(suSentThread, suLocal),
        }),
        tabsHtml: renderTabBar([{ title: 'method.tex', file: PATH }, { title: T.diffTabTitle(PATH, 'undo'), file: PATH, active: true, preview: true }]),
        editorHtml: renderDiffEditor(diffSidesOf(suLocal, suOverleaf)),
        statusHtml: status({ open: 0, note: T.SENT_VERIFIED }),
        cursorText: 'Ln 4, Col 1',
      },
      {
        sidebarHtml: sidebar({
          busy: true, state: state({ undo: {} }), openComments: 0, suggestions: 0,
          undo: suUndoView(true),
          rows: suRows(suSentThread, suLocal),
        }),
        tabsHtml: renderTabBar([{ title: 'method.tex', file: PATH }, { title: T.diffTabTitle(PATH, 'undo'), file: PATH, active: true, preview: true }]),
        editorHtml: renderDiffEditor(diffSidesOf(suLocal, suOverleaf)),
        statusHtml: status({ open: 0, note: T.SENT_VERIFIED }),
        cursorText: 'Ln 4, Col 1',
      },
      {
        // The local file keeps the edits, so it is listed as going out again.
        sidebarHtml: sidebar({
          state: state({ note: T.UNDO_SENT_VERIFIED, standing: { files: 1, comments: 0 } }), openComments: 1, suggestions: 0,
          outgoing: { files: [suFile], comments: [], check: suCheck },
          rows: suRows(suThread, suLocal),
        }),
        tabsHtml: renderTabBar([{ title: 'method.tex', file: PATH, active: true }]),
        editorHtml: renderCodeEditor({ lines: lines(suLocal), commentHighlights: { [lineOf(suLocal, suAnchor)]: suAnchor }, gutterComments: { [lineOf(suLocal, suAnchor)]: 'open' }, activeLine: 5 }),
        statusHtml: status({ unsent: 1, note: T.UNDO_SENT_VERIFIED }),
        cursorText: 'Ln 5, Col 1',
      },
    ],
    timeline(t, byState) {
      const send = target(byState, 0, 'button[data-command="send"]');
      const undo = target(byState, 2, 'button[data-command="undoSend"]');
      const sendUndo = target(byState, 3, 'button[data-command="sendUndo"]');
      const pos = interpolateCursor([
        { t: 0, x: 600, y: 300 },
        { t: 0.3, x: 600, y: 300 },
        { t: 1.0, x: send.x, y: send.y },
        { t: 1.55, x: send.x, y: send.y },
        { t: 2.4, x: undo.x + 40, y: undo.y + 30 },
        { t: 3.0, x: undo.x, y: undo.y },
        { t: 3.55, x: undo.x, y: undo.y },
        { t: 4.2, x: 790, y: 200 },
        { t: 5.0, x: 790, y: 215 },
        { t: 5.6, x: sendUndo.x, y: sendUndo.y },
        { t: 6.15, x: sendUndo.x, y: sendUndo.y },
        { t: 6.9, x: 600, y: 420 },
      ], t);
      const fx = clickEffects(t, [
        { t: 1.2, x: send.x, y: send.y, selector: 'button[data-command="send"]' },
        { t: 3.2, x: undo.x, y: undo.y, selector: 'button[data-command="undoSend"]' },
        { t: 5.8, x: sendUndo.x, y: sendUndo.y, selector: 'button[data-command="sendUndo"]' },
      ]);
      const step = stepAt(t, [
        { t: 0, stateIndex: 0, stepLabel: '1 / 3', caption: 'The outgoing summary lists every change' },
        { t: 1.32, stateIndex: 1, stepLabel: '1 / 3', caption: 'Send re-reads Overleaf, then writes' },
        { t: 2.05, stateIndex: 2, stepLabel: '2 / 3', caption: 'Sent and verified, with Undo' },
        { t: 3.32, stateIndex: 3, stepLabel: '3 / 3', caption: 'Undo this send: preview what is taken back' },
        { t: 5.92, stateIndex: 4, stepLabel: '3 / 3', caption: 'Undo this send: preview what is taken back' },
        { t: 6.6, stateIndex: 5, stepLabel: '3 / 3', caption: 'Undone on Overleaf; local edits stay' },
      ]);
      const hoverSelector = t >= 0.9 && t < 1.32 ? 'button[data-command="send"]'
        : t >= 2.9 && t < 3.32 ? 'button[data-command="undoSend"]'
          : t >= 5.5 && t < 5.92 ? 'button[data-command="sendUndo"]' : null;
      const flash = flashAt(t, [
        { t: 2.1, selector: '#turnleaf-sidebar .status', duration: 1.1 },
        { t: 6.65, selector: '#turnleaf-sidebar .status', duration: 1.3 },
      ]);
      return { ...step, hoverSelector, ...pos, ...fx, ...flash };
    },
  };

  // -------------------------------------------------------------------------
  // 4. Review files for AI agents and scripts
  // -------------------------------------------------------------------------
  const agBefore = join([
    '\\section{Evaluation}',
    'We report the scale-invariant SDR',
    'on the 10-hour test set.',
    '',
    '\\begin{equation}',
    '  \\mathrm{SDR} = 10\\log_{10}(\\|s\\|^2 / \\|e\\|^2)',
    '\\end{equation}',
    '',
    'All models run on identical splits.',
  ]);
  const agAfter = join([
    '\\section{Evaluation}',
    'We report the scale-invariant signal-to-distortion',
    'ratio (SDR, in dB) on the 10-hour test set.',
    '',
    '\\begin{equation}',
    '  \\mathrm{SDR} = 10\\log_{10}(\\|s\\|^2 / \\|e\\|^2)',
    '\\end{equation}',
    '',
    'All models run on identical splits.',
  ]);
  const AG_PATH = 'sections/evaluation.tex';
  const agAnchor = 'scale-invariant SDR';
  const agThread = {
    id: 't-42', resolved: false,
    messages: [{ id: 'm-42', author: 'Hannah Lin', authorId: 'u-hannah', timestamp: '2026-11-18T14:18:00', text: 'Could you define the SDR metric before Eq. (2)?' }],
  };
  const agReplyText = 'Defined SDR before Eq. (2).';
  const agInspectionOf = (text, thread, quoted) => {
    const i = inspectionOf({ text, threads: [thread], anchors: { 't-42': quoted } });
    i.docs[0].path = AG_PATH; i.docs[0].docId = 'doc-eval';
    return i;
  };
  const agAnchorAfter = 'scale-invariant signal-to-distortion';
  const agInspection = agInspectionOf(agBefore, agThread, agAnchor);
  const agSentThread = { ...agThread, messages: [...agThread.messages, { id: 'm-43', author: ME.name, authorId: ME.id, timestamp: '2026-11-18T14:30:00', text: agReplyText }] };
  const agSent = agInspectionOf(agAfter, agSentThread, agAnchorAfter);
  const agReply = { ...draft('reply', 't-42', { text: agReplyText }), id: 'reply-1', path: AG_PATH, docId: 'doc-eval' };
  const agKey = 'overleaf.com-6f3a9c2e';
  // The thread file exactly as the extension writes it, shown scrolled to localEdits.
  const agJson = (pending, inspection = agInspection) => {
    const record = recordFor({ key: agKey }, { schema: 2, anchors: {}, reviews: {}, pending, acknowledged: inspection, observed: inspection }, 't-42');
    record.generation = '0b7d2f4e-1c9a-4e55-9a51-3f0f6c7d2a10';
    return JSON.stringify(record, null, 2).split('\n');
  };
  const agJsonBefore = agJson([]), agJsonAfter = agJson([agReply]);
  const TAIL = 15;
  const tail = (rows) => ({ rightJsonLines: rows.slice(-TAIL), rightFirstLine: rows.length - TAIL + 1 });
  const agEditLines = agJsonAfter.map((line, i) => i + 1).filter((ln) => ln > agJsonBefore.length - 2 && ln < agJsonAfter.length);
  const agRow = (text, thread = agThread) => ({ ...rowOf(text, thread, text === agBefore ? agAnchor : agAnchorAfter), path: AG_PATH, docId: 'doc-eval' });
  const agFile = { path: AG_PATH, ...counts(agBefore, agAfter) };
  const agOutgoing = (withReply) => ({ files: [agFile], comments: withReply ? outgoingComments(agInspection, [agReply]) : [], check: { mode: 'full', live: true } });
  const reviewDir = `.turnleaf/projects/${agKey}/review`;
  const prompt = { kind: 'prompt', text: `paper % agent "Answer the open Overleaf comments in ${reviewDir}"` };
  const agTerm = (n) => [
    prompt,
    { kind: 'done', text: '✓ Read REVIEW.md: 1 open thread (t-42) in sections/evaluation.tex' },
    { kind: 'done', text: '✓ Edited sections/evaluation.tex: defined SDR before Eq. (2)' },
    { kind: 'done', text: '✓ Added a reply to localEdits in threads/t-42.json' },
    { kind: 'out', text: '  Turnleaf lists the reply as going out. Nothing is sent until you press Send.' },
  ].slice(0, n);
  const agEditor = (texAfter, json, flash = {}) => renderSplitAgentEditor({
    leftTab: { title: 'evaluation.tex', file: AG_PATH },
    rightTab: { title: 't-42.json', file: 't-42.json' },
    leftLines: lines(texAfter ? agAfter : agBefore),
    leftHighlights: { 2: texAfter ? agAnchorAfter : agAnchor },
    ...tail(json),
    ...flash,
  });
  const agViewBase = { activePath: AG_PATH, files: ['main.tex', AG_PATH], openComments: 1, suggestions: 0, reviewFiles: true };
  const agStatus = (input) => status(input);

  const agentReviewScene = {
    id: 'agent-review',
    title: 'Review files for AI agents and scripts',
    fps: 15,
    duration: 8.2,
    targetSelectors: ['button[data-command="send"]'],
    states: [
      {
        sidebarHtml: sidebar({ ...agViewBase, state: state({}), rows: [agRow(agBefore)] }),
        tabsHtml: '',
        editorHtml: agEditor(false, agJsonBefore, { terminalLines: agTerm(2) }),
        statusHtml: agStatus({}),
        cursorText: 'Ln 2, Col 1',
      },
      {
        // A saved source file is listed as going out at once.
        sidebarHtml: sidebar({ ...agViewBase, state: state({ standing: { files: 1, comments: 0 } }), outgoing: agOutgoing(false), rows: [agRow(agAfter)] }),
        tabsHtml: '',
        editorHtml: agEditor(true, agJsonBefore, { leftFlashLines: [2, 3], terminalLines: agTerm(3) }),
        statusHtml: agStatus({ unsent: 1 }),
        cursorText: 'Ln 3, Col 44',
      },
      {
        // Saving the thread file imports its localEdits as drafts.
        sidebarHtml: sidebar({
          ...agViewBase, state: state({ note: T.REVIEW_FILES_IMPORTED, standing: { files: 1, comments: 1 } }),
          drafts: [draftView(agReply)], outgoing: agOutgoing(true), rows: [agRow(agAfter)],
        }),
        tabsHtml: '',
        editorHtml: agEditor(true, agJsonAfter, { rightJsonFlashLines: agEditLines, terminalLines: agTerm(5) }),
        statusHtml: agStatus({ unsent: 2, note: T.REVIEW_FILES_IMPORTED }),
        cursorText: `Ln ${agJsonAfter.length - 1}, Col 1`,
      },
      {
        sidebarHtml: sidebar({
          ...agViewBase, busy: true, state: state({ note: T.REVIEW_FILES_IMPORTED, standing: { files: 1, comments: 1 } }),
          drafts: [draftView(agReply)], outgoing: { ...agOutgoing(true), busy: true }, rows: [agRow(agAfter)],
        }),
        tabsHtml: '',
        editorHtml: agEditor(true, agJsonAfter, { terminalLines: agTerm(5) }),
        statusHtml: agStatus({ unsent: 2, note: T.REVIEW_FILES_IMPORTED }),
        cursorText: `Ln ${agJsonAfter.length - 1}, Col 1`,
      },
      {
        sidebarHtml: sidebar({
          ...agViewBase, state: state({ note: T.SENT_VERIFIED }), undoLatest: 'send-2',
          rows: [agRow(agAfter, agSentThread)],
        }),
        tabsHtml: '',
        editorHtml: agEditor(true, agJson([], agSent), { terminalLines: agTerm(5) }),
        statusHtml: agStatus({ note: T.SENT_VERIFIED }),
        cursorText: `Ln ${agJsonAfter.length - 1}, Col 1`,
      },
    ],
    timeline(t, byState) {
      const send = target(byState, 2, 'button[data-command="send"]');
      const pos = interpolateCursor([
        { t: 0, x: 760, y: 600 },
        { t: 1.6, x: 640, y: 200 },
        { t: 2.6, x: 640, y: 215 },
        { t: 3.6, x: 900, y: 300 },
        { t: 4.8, x: 900, y: 310 },
        { t: 5.5, x: send.x, y: send.y },
        { t: 6.1, x: send.x, y: send.y },
        { t: 6.8, x: 600, y: 420 },
      ], t);
      const fx = clickEffects(t, [{ t: 5.75, x: send.x, y: send.y, selector: 'button[data-command="send"]' }]);
      const step = stepAt(t, [
        { t: 0, stateIndex: 0, stepLabel: '1 / 3', caption: 'An agent reads the comments from local review files' },
        { t: 1.6, stateIndex: 1, stepLabel: '2 / 3', caption: 'It edits the source and queues a reply' },
        { t: 3.3, stateIndex: 2, stepLabel: '2 / 3', caption: 'It edits the source and queues a reply' },
        { t: 5.87, stateIndex: 3, stepLabel: '3 / 3', caption: 'You review the summary and Send' },
        { t: 6.5, stateIndex: 4, stepLabel: '3 / 3', caption: 'You review the summary and Send' },
      ]);
      const hoverSelector = t >= 5.4 && t < 5.87 ? 'button[data-command="send"]' : null;
      const flash = flashAt(t, [
        { t: 1.65, selector: '#turnleaf-sidebar .outgoing-summary', duration: 0.9 },
        { t: 3.35, selector: '#turnleaf-sidebar .outgoing-summary', duration: 1.0 },
        { t: 6.55, selector: '#turnleaf-sidebar .status', duration: 1.2 },
      ]);
      return { ...step, hoverSelector, ...pos, ...fx, ...flash };
    },
  };

  return [getLatestScene, commentsScene, sendAndUndoScene, agentReviewScene];
}
