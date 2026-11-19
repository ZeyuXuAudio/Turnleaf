import {
  renderBreadcrumbs,
  renderCodeEditor,
  renderDiffEditor,
  renderSplitAgentEditor,
  renderTabBar,
} from './vscodeChrome.mjs';

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function interpolateCursor(waypoints, t) {
  if (!waypoints.length) return { x: 640, y: 300 };
  if (t <= waypoints[0].t) return { x: waypoints[0].x, y: waypoints[0].y };
  for (let i = 1; i < waypoints.length; i++) {
    const prev = waypoints[i - 1];
    const curr = waypoints[i];
    if (t <= curr.t) {
      const span = Math.max(0.0001, curr.t - prev.t);
      const u = easeInOutCubic(clamp01((t - prev.t) / span));
      return {
        x: prev.x + (curr.x - prev.x) * u,
        y: prev.y + (curr.y - prev.y) * u,
      };
    }
  }
  const last = waypoints[waypoints.length - 1];
  return { x: last.x, y: last.y };
}

function clickEffects(t, clicks) {
  let pressing = false;
  let ripple = 0;
  let rippleX = 0;
  let rippleY = 0;
  for (const c of clicks) {
    if (t >= c.t - 0.08 && t <= c.t + 0.07) pressing = true;
    if (t >= c.t && t <= c.t + 0.36) {
      ripple = (t - c.t) / 0.36;
      rippleX = c.x;
      rippleY = c.y;
    }
  }
  return { pressing, ripple, rippleX, rippleY };
}

const baseProject = {
  name: 'Spatial Audio Paper',
  server: 'https://www.overleaf.com',
  files: ['main.tex', 'sections/method.tex'],
  writes: true,
  connected: true,
  linked: true,
  activePath: 'sections/method.tex',
  userId: 'u-alex',
  reviews: {},
  allComments: false,
};

const hannahThreadBase = {
  id: 't-1',
  resolved: false,
  messages: [
    {
      id: 'm-1',
      author: 'Hannah Lin',
      authorId: 'u-hannah',
      timestamp: '2026-11-18T14:10:00',
      text: 'Should we state the sampling rate here?',
    },
  ],
};

const hannahThreadWithReply = {
  id: 't-1',
  resolved: false,
  messages: [
    ...hannahThreadBase.messages,
    {
      id: 'm-2',
      author: 'Hannah Lin',
      authorId: 'u-hannah',
      timestamp: '2026-11-18T14:21:00',
      text: 'Added a short note on 48 kHz calibration.',
    },
  ],
};

const hannahRow = (thread, line = 8, excerpt = 'input signal $x(t)$') => ({
  path: 'sections/method.tex',
  docId: 'doc-method',
  line,
  excerpt,
  anchor: { label: 'unchanged', ranges: [] },
  thread,
});

export function createScenes({ projectContent }) {
  // -------------------------------------------------------------------------
  // 1. Get latest with 3-way merge preview
  // -------------------------------------------------------------------------
  const getLatestMethodBefore = [
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
  ];

  const getLatestMethodAfter = [
    '\\section{Signal Model}',
    '\\label{sec:method}',
    '',
    'We model the 48\\,kHz microphone array',
    'using short-time Fourier frames $X_{m}(f)$.',
    '',
    '\\begin{equation}',
    '  y_m(t) = h_m * x(t)',
    '\\end{equation}',
    '',
    'Each frame uses a 512-sample Hann window',
    'with 50\\% overlap between adjacent hops.',
    'The steering vector $\\mathbf{a}(\\theta)$',
    '% Local draft: verify array geometry',
  ];

  const getLatestScene = {
    id: 'get-latest',
    title: 'Get latest with merge preview',
    fps: 15,
    duration: 8.5,
    targetSelectors: [
      'button[data-command="pull"]',
      'button[data-command="applyReviewed"]',
      '.file-button[data-path="sections/method.tex"]',
    ],
    states: [
      {
        sidebarHtml: projectContent({
          ...baseProject,
          state: 'Incoming changes on Overleaf.',
          freshness: 'Incoming changes on Overleaf',
          openComments: 1,
          suggestions: 0,
          outgoing: { files: [], comments: [] },
          rows: [hannahRow(hannahThreadBase, 8)],
        }, 'sidebar'),
        tabsHtml: renderTabBar({ title: 'sections/method.tex' }),
        breadcrumbsHtml: renderBreadcrumbs(['sections', 'method.tex', '\\section{Signal Model}']),
        editorHtml: renderCodeEditor({
          lines: getLatestMethodBefore,
          commentHighlights: { 8: 'x(t)' },
          gutterComments: { 8: 'open' },
          activeLine: 14,
        }),
        statusText: 'Incoming changes · 1 file on Overleaf',
        cursorText: 'Ln 14, Col 46',
      },
      {
        sidebarHtml: projectContent({
          ...baseProject,
          state: 'Preview ready. Review before applying.',
          openComments: 1,
          suggestions: 0,
          preview: {
            id: 'prev-1',
            selectedPath: 'sections/method.tex',
            files: [{ path: 'sections/method.tex', added: 3, removed: 2 }],
            comments: [
              {
                id: 't-1',
                path: 'sections/method.tex',
                label: 'New reply',
                line: 8,
                before: hannahThreadBase,
                after: hannahThreadWithReply,
              },
            ],
          },
          rows: [hannahRow(hannahThreadBase, 8)],
        }, 'sidebar'),
        tabsHtml: renderTabBar({ title: 'sections/method.tex', diffLabel: 'Local now ↔ After merge' }),
        breadcrumbsHtml: renderBreadcrumbs(['Turnleaf Preview', 'sections/method.tex', '3-way merge']),
        editorHtml: renderDiffEditor({
          leftLabel: 'Local now',
          rightLabel: 'After merge',
          leftLines: [
            { ln: 1, text: '\\section{Signal Model}' },
            { ln: 2, text: '\\label{sec:method}' },
            { ln: 3, text: '' },
            { ln: 4, kind: 'removed', text: 'We model the microphone array response', span: 'microphone array response' },
            { ln: 5, text: 'using short-time Fourier frames $X_{m}(f)$.' },
            { ln: 6, text: '' },
            { ln: 7, text: '\\begin{equation}' },
            { ln: 8, text: '  y_m(t) = h_m * x(t)' },
            { ln: 9, text: '\\end{equation}' },
            { ln: 10, text: '' },
            { ln: 11, kind: 'removed', text: 'Each frame uses a 512-sample Hann window.', span: 'window.' },
            { kind: 'blank' },
            { ln: 12, text: 'The steering vector $\\mathbf{a}(\\theta)$' },
            { ln: 14, text: '% Local draft: verify array geometry' },
          ],
          rightLines: [
            { ln: 1, text: '\\section{Signal Model}' },
            { ln: 2, text: '\\label{sec:method}' },
            { ln: 3, text: '' },
            { ln: 4, kind: 'added', text: 'We model the 48\\,kHz microphone array', span: '48\\,kHz microphone array' },
            { ln: 5, text: 'using short-time Fourier frames $X_{m}(f)$.' },
            { ln: 6, text: '' },
            { ln: 7, text: '\\begin{equation}' },
            { ln: 8, text: '  y_m(t) = h_m * x(t)', note: '💬 New reply (Hannah)' },
            { ln: 9, text: '\\end{equation}' },
            { ln: 10, text: '' },
            { ln: 11, kind: 'added', text: 'Each frame uses a 512-sample Hann window', span: 'window' },
            { ln: 12, kind: 'added', text: 'with 50\\% overlap between adjacent hops.', span: 'with 50\\% overlap between adjacent hops.' },
            { ln: 13, text: 'The steering vector $\\mathbf{a}(\\theta)$' },
            { ln: 14, text: '% Local draft: verify array geometry' },
          ],
        }),
        statusText: 'Merge preview · 2 updates ready',
        cursorText: 'Diff view',
      },
      {
        sidebarHtml: projectContent({
          ...baseProject,
          state: 'Up to date.',
          openComments: 1,
          suggestions: 0,
          outgoing: { files: [], comments: [] },
          rows: [hannahRow(hannahThreadWithReply, 8)],
        }, 'sidebar'),
        tabsHtml: renderTabBar({ title: 'sections/method.tex' }),
        breadcrumbsHtml: renderBreadcrumbs(['sections', 'method.tex', '\\section{Signal Model}']),
        editorHtml: renderCodeEditor({
          lines: getLatestMethodAfter,
          commentHighlights: { 8: 'x(t)' },
          gutterComments: { 8: 'open' },
          flashLines: [4, 11, 12],
          activeLine: 14,
        }),
        statusText: 'Up to date · local edits preserved',
        cursorText: 'Ln 14, Col 46',
      },
    ],
    timeline(t, byState) {
      const pull = byState[0]?.['button[data-command="pull"]'] ?? { x: 120, y: 185 };
      const diffArea = { x: 690, y: 295 };
      const apply = byState[1]?.['button[data-command="applyReviewed"]'] ?? { x: 180, y: 185 };
      const rest = { x: 640, y: 420 };

      const waypoints = [
        { t: 0.0, x: 520, y: 310 },
        { t: 0.45, x: 520, y: 310 },
        { t: 1.25, x: pull.x, y: pull.y },
        { t: 1.85, x: pull.x, y: pull.y },
        { t: 2.9, x: diffArea.x, y: diffArea.y },
        { t: 3.7, x: diffArea.x, y: diffArea.y },
        { t: 4.55, x: apply.x, y: apply.y },
        { t: 5.25, x: apply.x, y: apply.y },
        { t: 6.4, x: rest.x, y: rest.y },
        { t: 8.5, x: rest.x, y: rest.y },
      ];
      const pos = interpolateCursor(waypoints, t);
      const fx = clickEffects(t, [
        { t: 1.5, x: pull.x, y: pull.y },
        { t: 4.85, x: apply.x, y: apply.y },
      ]);

      let stateIndex = 0;
      let stepLabel = '1 / 3';
      let caption = 'Overleaf changes detected';
      let hoverSelector = null;

      if (t >= 1.8 && t < 5.2) {
        stateIndex = 1;
        stepLabel = '2 / 3';
        caption = 'Preview the 3-way merge diff';
        if (t >= 4.4 && t < 5.15) hoverSelector = 'button[data-command="applyReviewed"]';
      } else if (t >= 5.2) {
        stateIndex = 2;
        stepLabel = '3 / 3';
        caption = 'Applied cleanly — local edits kept';
      } else if (t >= 1.1 && t < 1.78) {
        hoverSelector = 'button[data-command="pull"]';
      }

      return { stateIndex, stepLabel, caption, hoverSelector, ...pos, ...fx };
    },
  };

  // -------------------------------------------------------------------------
  // 2. Comments & suggestions in the editor
  // -------------------------------------------------------------------------
  const commentsLines = [
    '\\section{Signal Model}',
    '\\label{sec:method}',
    '',
    'The input signal is sampled',
    'at 48 kHz with a 512-sample Hann window.',
    'Array coordinates follow the spherical setup.',
    '',
    'We capture multi-channel room impulse responses',
    'under controlled reverberation ($T_{60} = 0.45\\,$s).',
    '\\begin{equation}',
    '  y_m(t) = h_m * x(t)',
    '\\end{equation}',
  ];

  const replyDraftText = 'Done — added 48 kHz in Section 3.';
  const replyDraftRecord = {
    id: 'draft-reply-1',
    kind: 'reply',
    path: 'sections/method.tex',
    threadId: 't-1',
    text: replyDraftText,
  };
  const replyOutgoingChange = {
    id: 'draft-reply-1',
    draftId: 'draft-reply-1',
    path: 'sections/method.tex',
    label: 'Reply',
    line: 11,
    before: hannahThreadBase,
    after: {
      id: 't-1',
      resolved: false,
      messages: [
        ...hannahThreadBase.messages,
        { id: 'draft:1', author: 'Alex Chen', authorId: 'u-alex', timestamp: '2026-11-18T14:24:00', text: replyDraftText },
      ],
    },
  };
  const acceptOutgoingChange = {
    id: 'draft-acc-1',
    draftId: 'draft-acc-1',
    path: 'sections/method.tex',
    label: 'Accept suggestion',
    line: 5,
    suggestion: {
      decision: 'accept',
      kind: 'insert',
      text: 'at 48 kHz with a 512-sample Hann window.',
      author: 'David Park',
      line: 5,
    },
  };

  const davidSuggestion = (decision) => ({
    id: 's-1',
    path: 'sections/method.tex',
    line: 5,
    pos: 85,
    kind: 'insert',
    text: 'at 48 kHz with a 512-sample Hann window.',
    author: 'David Park',
    timestamp: '2026-11-18T14:15:00',
    decision,
  });

  const commentsScene = {
    id: 'comments-suggestions',
    title: 'Comments and suggestions in the editor',
    fps: 15,
    duration: 9.0,
    targetSelectors: [
      'button[data-id="t-1"]',
      '[data-demo-target="inline-reply-btn"]',
      'button[data-command="acceptChange"]',
      'button[data-command="send"]',
    ],
    states: [
      // State 0: Overview before opening inline thread
      {
        sidebarHtml: projectContent({
          ...baseProject,
          state: 'Up to date.',
          openComments: 1,
          suggestions: 1,
          outgoing: { files: [], comments: [] },
          rows: [hannahRow(hannahThreadBase, 11)],
          suggestionRows: [davidSuggestion()],
        }, 'sidebar'),
        tabsHtml: renderTabBar({ title: 'sections/method.tex' }),
        breadcrumbsHtml: renderBreadcrumbs(['sections', 'method.tex', '\\section{Signal Model}']),
        editorHtml: renderCodeEditor({
          lines: commentsLines,
          commentHighlights: { 11: 'x(t)' },
          gutterComments: { 11: 'open' },
          suggestions: { 5: 'at 48 kHz with a 512-sample Hann window.' },
          activeLine: 11,
        }),
        statusText: '1 open · 1 suggestion',
        cursorText: 'Ln 11, Col 19',
      },
      // State 1: Inline comment thread expanded & typing reply
      {
        sidebarHtml: projectContent({
          ...baseProject,
          state: 'Up to date.',
          openComments: 1,
          suggestions: 1,
          selectedThread: 't-1',
          outgoing: { files: [], comments: [] },
          rows: [hannahRow(hannahThreadBase, 11)],
          suggestionRows: [davidSuggestion()],
        }, 'sidebar'),
        tabsHtml: renderTabBar({ title: 'sections/method.tex' }),
        breadcrumbsHtml: renderBreadcrumbs(['sections', 'method.tex', '\\section{Signal Model}']),
        editorHtml: renderCodeEditor({
          lines: commentsLines,
          commentHighlights: { 11: 'x(t)' },
          gutterComments: { 11: 'open' },
          suggestions: { 5: 'at 48 kHz with a 512-sample Hann window.' },
          activeLine: 11,
          inlineThread: {
            afterLine: 11,
            title: 'Hannah Lin',
            messages: [
              { author: 'Hannah Lin', time: 'Nov 18, 14:10', text: 'Should we state the sampling rate here?' },
            ],
            showReplyBox: true,
            typedText: '',
            typingFocused: true,
            caretActive: true,
          },
        }),
        statusText: '1 open · 1 suggestion',
        cursorText: 'Ln 11, Col 19',
      },
      // State 2: Reply saved locally (Pending send), now targeting suggestion Accept button
      {
        sidebarHtml: projectContent({
          ...baseProject,
          state: '1 comment change waiting to send.',
          openComments: 1,
          suggestions: 1,
          drafts: [replyDraftRecord],
          outgoing: {
            files: [],
            comments: [replyOutgoingChange],
          },
          rows: [hannahRow(hannahThreadBase, 11)],
          suggestionRows: [davidSuggestion()],
        }, 'sidebar'),
        tabsHtml: renderTabBar({ title: 'sections/method.tex' }),
        breadcrumbsHtml: renderBreadcrumbs(['sections', 'method.tex', '\\section{Signal Model}']),
        editorHtml: renderCodeEditor({
          lines: commentsLines,
          commentHighlights: { 11: 'x(t)' },
          gutterComments: { 11: 'open' },
          suggestions: { 5: 'at 48 kHz with a 512-sample Hann window.' },
          activeLine: 5,
          inlineThread: {
            afterLine: 11,
            title: 'Hannah Lin',
            messages: [
              { author: 'Hannah Lin', time: 'Nov 18, 14:10', text: 'Should we state the sampling rate here?' },
              { author: 'Alex Chen', time: 'Nov 18, 14:24', text: replyDraftText, pending: true },
            ],
            showReplyBox: false,
          },
        }),
        statusText: '1 draft queued · nothing sent yet',
        cursorText: 'Ln 5, Col 1',
      },
      // State 3: Suggestion accepted as draft too -> 2 comment changes waiting in Outgoing summary
      {
        sidebarHtml: projectContent({
          ...baseProject,
          state: '2 comment changes waiting to send.',
          openComments: 1,
          suggestions: 1,
          drafts: [
            replyDraftRecord,
            { id: 'draft-acc-1', kind: 'acceptChange', path: 'sections/method.tex' },
          ],
          outgoing: {
            files: [],
            comments: [replyOutgoingChange, acceptOutgoingChange],
          },
          rows: [hannahRow(hannahThreadBase, 11)],
          suggestionRows: [davidSuggestion('accept')],
        }, 'sidebar'),
        tabsHtml: renderTabBar({ title: 'sections/method.tex' }),
        breadcrumbsHtml: renderBreadcrumbs(['sections', 'method.tex', '\\section{Signal Model}']),
        editorHtml: renderCodeEditor({
          lines: commentsLines,
          commentHighlights: { 11: 'x(t)' },
          gutterComments: { 11: 'open' },
          flashLines: [5],
          activeLine: 5,
          inlineThread: {
            afterLine: 11,
            title: 'Hannah Lin',
            messages: [
              { author: 'Hannah Lin', time: 'Nov 18, 14:10', text: 'Should we state the sampling rate here?' },
              { author: 'Alex Chen', time: 'Nov 18, 14:24', text: replyDraftText, pending: true },
            ],
            showReplyBox: false,
          },
        }),
        statusText: '2 drafts ready · Send when ready',
        cursorText: 'Ln 5, Col 41',
      },
    ],
    timeline(t, byState) {
      const cardBtn = byState[0]?.['button[data-id="t-1"]'] ?? { x: 180, y: 500 };
      const replyBtn = byState[1]?.['[data-demo-target="inline-reply-btn"]'] ?? { x: 1018, y: 465 };
      const acceptBtn = byState[2]?.['button[data-command="acceptChange"]'] ?? { x: 274, y: 495 };
      const sendBtn = byState[3]?.['button[data-command="send"]'] ?? { x: 255, y: 185 };

      const waypoints = [
        { t: 0.0, x: 640, y: 240 },
        { t: 0.4, x: 640, y: 240 },
        { t: 1.15, x: cardBtn.x, y: cardBtn.y },
        { t: 1.75, x: cardBtn.x, y: cardBtn.y },
        { t: 2.55, x: 740, y: replyBtn.y },
        { t: 3.9, x: 740, y: replyBtn.y },
        { t: 4.5, x: replyBtn.x, y: replyBtn.y },
        { t: 5.25, x: replyBtn.x, y: replyBtn.y },
        { t: 6.0, x: acceptBtn.x, y: acceptBtn.y },
        { t: 6.7, x: acceptBtn.x, y: acceptBtn.y },
        { t: 7.7, x: sendBtn.x, y: sendBtn.y },
        { t: 9.0, x: sendBtn.x, y: sendBtn.y },
      ];
      const pos = interpolateCursor(waypoints, t);
      const fx = clickEffects(t, [
        { t: 1.38, x: cardBtn.x, y: cardBtn.y },
        { t: 4.78, x: replyBtn.x, y: replyBtn.y },
        { t: 6.22, x: acceptBtn.x, y: acceptBtn.y },
      ]);

      let stateIndex = 0;
      let stepLabel = '1 / 3';
      let caption = 'Overleaf comments & suggestions inline';
      let hoverSelector = null;
      let typedText;
      let caretOn = false;
      let inputFocused = false;

      if (t < 1.7) {
        if (t >= 1.0 && t < 1.65) hoverSelector = 'button[data-id="t-1"]';
      } else if (t >= 1.7 && t < 5.15) {
        stateIndex = 1;
        stepLabel = '2 / 3';
        caption = 'Reply directly in the editor';
        inputFocused = true;
        const typeStart = 2.05;
        const typeEnd = 4.15;
        const progress = clamp01((t - typeStart) / (typeEnd - typeStart));
        const charCount = Math.round(progress * replyDraftText.length);
        typedText = replyDraftText.slice(0, charCount);
        caretOn = t < 4.55 && Math.floor(t * 2.5) % 2 === 0;
        if (t >= 4.4 && t < 5.1) hoverSelector = '[data-demo-target="inline-reply-btn"]';
      } else if (t >= 5.15 && t < 6.55) {
        stateIndex = 2;
        stepLabel = '3 / 3';
        caption = 'Accept suggestions & queue drafts';
        if (t >= 5.85 && t < 6.5) hoverSelector = 'button[data-command="acceptChange"]';
      } else {
        stateIndex = 3;
        stepLabel = '3 / 3';
        caption = 'Accept suggestions & queue drafts';
        if (t >= 7.65) hoverSelector = 'button[data-command="send"]';
      }

      return {
        stateIndex,
        stepLabel,
        caption,
        hoverSelector,
        typedText,
        caretOn,
        inputFocused,
        ...pos,
        ...fx,
      };
    },
  };

  // -------------------------------------------------------------------------
  // 3. Checked Send & Undo this send
  // -------------------------------------------------------------------------
  const sendMethodRemote = [
    { ln: 1, text: '\\section{Signal Model}' },
    { ln: 2, text: '\\label{sec:method}' },
    { ln: 3, text: '' },
    { ln: 4, kind: 'removed', text: 'We capture room impulse responses.', span: 'room impulse responses.' },
    { kind: 'blank' },
    { ln: 5, text: '\\begin{equation}' },
    { ln: 6, text: '  y_m(t) = h_m * x(t) + n_m(t)' },
    { ln: 7, text: '\\end{equation}' },
    { ln: 8, text: '' },
    { ln: 9, text: 'Each frame uses a 512-sample Hann window.' },
  ];

  const sendMethodLocal = [
    { ln: 1, text: '\\section{Signal Model}' },
    { ln: 2, text: '\\label{sec:method}' },
    { ln: 3, text: '' },
    { ln: 4, kind: 'added', text: 'We capture 48 kHz impulse responses', span: '48 kHz impulse responses' },
    { ln: 5, kind: 'added', text: 'across 16 calibrated microphone capsules.', span: 'across 16 calibrated microphone capsules.' },
    { ln: 6, text: '\\begin{equation}' },
    { ln: 7, text: '  y_m(t) = h_m * x(t) + n_m(t)' },
    { ln: 8, text: '\\end{equation}' },
    { ln: 9, text: '' },
    { ln: 10, text: 'Each frame uses a 512-sample Hann window.' },
  ];

  const undoMethodAfter = [
    { ln: 1, text: '\\section{Signal Model}' },
    { ln: 2, text: '\\label{sec:method}' },
    { ln: 3, text: '' },
    { ln: 4, kind: 'added', text: 'We capture room impulse responses.', span: 'room impulse responses.' },
    { kind: 'blank' },
    { ln: 5, text: '\\begin{equation}' },
    { ln: 6, text: '  y_m(t) = h_m * x(t) + n_m(t)' },
    { ln: 7, text: '\\end{equation}' },
    { ln: 8, text: '' },
    { ln: 9, text: 'Each frame uses a 512-sample Hann window.' },
  ];

  const undoMethodCurrent = [
    { ln: 1, text: '\\section{Signal Model}' },
    { ln: 2, text: '\\label{sec:method}' },
    { ln: 3, text: '' },
    { ln: 4, kind: 'removed', text: 'We capture 48 kHz impulse responses', span: '48 kHz impulse responses' },
    { ln: 5, kind: 'removed', text: 'across 16 calibrated microphone capsules.', span: 'across 16 calibrated microphone capsules.' },
    { ln: 6, text: '\\begin{equation}' },
    { ln: 7, text: '  y_m(t) = h_m * x(t) + n_m(t)' },
    { ln: 8, text: '\\end{equation}' },
    { ln: 9, text: '' },
    { ln: 10, text: 'Each frame uses a 512-sample Hann window.' },
  ];

  const sendCleanLines = [
    '\\section{Signal Model}',
    '\\label{sec:method}',
    '',
    'We capture 48 kHz impulse responses',
    'across 16 calibrated microphone capsules.',
    '\\begin{equation}',
    '  y_m(t) = h_m * x(t) + n_m(t)',
    '\\end{equation}',
    '',
    'Each frame uses a 512-sample Hann window.',
  ];

  const sendOutgoingComments = [
    {
      id: 'd-reply',
      draftId: 'd-reply',
      path: 'sections/method.tex',
      label: 'Reply',
      line: 7,
      before: hannahThreadBase,
      after: {
        id: 't-1',
        resolved: false,
        messages: [
          ...hannahThreadBase.messages,
          { id: 'draft:1', author: 'Alex Chen', authorId: 'u-alex', timestamp: '2026-11-18T14:22:00', text: 'Clarified 48 kHz and 16 capsules.' },
        ],
      },
    },
    {
      id: 'd-resolve',
      draftId: 'd-resolve',
      path: 'sections/method.tex',
      label: 'Resolve thread',
      line: 7,
      before: hannahThreadBase,
      after: { ...hannahThreadBase, resolved: true },
    },
  ];

  const sendAndUndoScene = {
    id: 'send-and-undo',
    title: 'Checked Send and Undo this send',
    fps: 15,
    duration: 9.0,
    targetSelectors: [
      'button[data-command="send"]',
      'button[data-command="undoSend"]',
      'button[data-command="sendUndo"]',
    ],
    states: [
      // State 0: Outgoing summary ready to Send
      {
        sidebarHtml: projectContent({
          ...baseProject,
          state: 'Ready to send.',
          openComments: 1,
          suggestions: 0,
          drafts: [
            { id: 'd-reply', kind: 'reply', path: 'sections/method.tex', threadId: 't-1', text: 'Clarified 48 kHz and 16 capsules.' },
            { id: 'd-resolve', kind: 'resolve', path: 'sections/method.tex', threadId: 't-1' },
          ],
          outgoing: {
            files: [{ path: 'sections/method.tex', added: 2, removed: 1 }],
            comments: sendOutgoingComments,
            selectedPath: 'sections/method.tex',
            check: { mode: 'full', live: true },
            asOf: '14:21',
          },
          rows: [hannahRow(hannahThreadBase, 7)],
        }, 'sidebar'),
        tabsHtml: renderTabBar({ title: 'sections/method.tex', diffLabel: 'Overleaf now ↔ After send' }),
        breadcrumbsHtml: renderBreadcrumbs(['Outgoing Diff', 'sections/method.tex', 'Full check']),
        editorHtml: renderDiffEditor({
          leftLabel: 'Overleaf now',
          rightLabel: 'After send',
          leftLines: sendMethodRemote,
          rightLines: sendMethodLocal,
        }),
        statusText: 'Ready · 1 file, 2 comment changes',
        cursorText: 'Diff view',
      },
      // State 1: Re-checking Overleaf & writing
      {
        sidebarHtml: projectContent({
          ...baseProject,
          busy: true,
          state: 'Checking Overleaf and sending…',
          openComments: 1,
          suggestions: 0,
          outgoing: {
            busy: true,
            files: [{ path: 'sections/method.tex', added: 2, removed: 1 }],
            comments: sendOutgoingComments,
            selectedPath: 'sections/method.tex',
            check: { mode: 'full', live: true },
            asOf: '14:21',
          },
          rows: [hannahRow(hannahThreadBase, 7)],
        }, 'sidebar'),
        tabsHtml: renderTabBar({ title: 'sections/method.tex', diffLabel: 'Overleaf now ↔ After send' }),
        breadcrumbsHtml: renderBreadcrumbs(['Outgoing Diff', 'sections/method.tex', 'Verifying…']),
        editorHtml: renderDiffEditor({
          leftLabel: 'Overleaf now',
          rightLabel: 'After send',
          leftLines: sendMethodRemote,
          rightLines: sendMethodLocal,
        }),
        statusText: 'Checking Overleaf before & after send…',
        cursorText: 'Diff view',
      },
      // State 2: Sent and verified on Overleaf, Undo link visible
      {
        sidebarHtml: projectContent({
          ...baseProject,
          state: 'Sent and verified on Overleaf.',
          undoLatest: 'send-1',
          openComments: 0,
          suggestions: 0,
          outgoing: { files: [], comments: [] },
          rows: [hannahRow({ ...hannahThreadBase, resolved: true }, 7)],
        }, 'sidebar'),
        tabsHtml: renderTabBar({ title: 'sections/method.tex' }),
        breadcrumbsHtml: renderBreadcrumbs(['sections', 'method.tex', '\\section{Signal Model}']),
        editorHtml: renderCodeEditor({
          lines: sendCleanLines,
          commentHighlights: { 7: 'x(t)' },
          gutterComments: { 7: 'resolved' },
          flashLines: [4, 5],
          activeLine: 5,
        }),
        statusText: 'Sent and verified on Overleaf',
        cursorText: 'Ln 5, Col 41',
      },
      // State 3: Undo summary opened — reverse diff shown, local files untouched
      {
        sidebarHtml: projectContent({
          ...baseProject,
          state: 'Sent and verified on Overleaf.',
          openComments: 0,
          suggestions: 0,
          undo: {
            record: 'send-1',
            time: '2026-11-18T14:22:00',
            selectedPath: 'undo:sections/method.tex',
            files: [{ path: 'sections/method.tex', added: 1, removed: 2 }],
            comments: [
              {
                id: 'u-reply',
                path: 'sections/method.tex',
                label: 'Remove reply & reopen thread',
                line: 7,
              },
            ],
            stays: [],
          },
          rows: [hannahRow({ ...hannahThreadBase, resolved: true }, 7)],
        }, 'sidebar'),
        tabsHtml: renderTabBar({ title: 'sections/method.tex', diffLabel: 'Overleaf now ↔ After undo' }),
        breadcrumbsHtml: renderBreadcrumbs(['Undo Preview', 'sections/method.tex', 'Local files stay']),
        editorHtml: renderDiffEditor({
          leftLabel: 'Overleaf now',
          rightLabel: 'After undo',
          leftLines: undoMethodCurrent,
          rightLines: undoMethodAfter,
        }),
        statusText: 'Undo preview · local files untouched',
        cursorText: 'Diff view',
      },
    ],
    timeline(t, byState) {
      const sendBtn = byState[0]?.['button[data-command="send"]'] ?? { x: 255, y: 185 };
      const undoLink = byState[2]?.['button[data-command="undoSend"]'] ?? { x: 295, y: 112 };
      const sendUndoBtn = byState[3]?.['button[data-command="sendUndo"]'] ?? { x: 115, y: 185 };

      const waypoints = [
        { t: 0.0, x: 520, y: 310 },
        { t: 0.4, x: 520, y: 310 },
        { t: 1.4, x: sendBtn.x, y: sendBtn.y },
        { t: 2.3, x: sendBtn.x, y: sendBtn.y },
        { t: 3.3, x: 460, y: 210 },
        { t: 4.5, x: undoLink.x, y: undoLink.y },
        { t: 5.3, x: undoLink.x, y: undoLink.y },
        { t: 6.4, x: sendUndoBtn.x, y: sendUndoBtn.y },
        { t: 9.0, x: sendUndoBtn.x, y: sendUndoBtn.y },
      ];
      const pos = interpolateCursor(waypoints, t);
      const fx = clickEffects(t, [
        { t: 1.78, x: sendBtn.x, y: sendBtn.y },
        { t: 4.92, x: undoLink.x, y: undoLink.y },
      ]);

      let stateIndex = 0;
      let stepLabel = '1 / 3';
      let caption = 'Outgoing summary lists exact changes';
      let hoverSelector = null;

      if (t < 2.1) {
        if (t >= 1.3 && t < 2.05) hoverSelector = 'button[data-command="send"]';
      } else if (t >= 2.1 && t < 3.05) {
        stateIndex = 1;
        stepLabel = '2 / 3';
        caption = 'Re-checked before writing & verified';
      } else if (t >= 3.05 && t < 5.3) {
        stateIndex = 2;
        stepLabel = '2 / 3';
        caption = 'Verified on Overleaf — Undo ready';
        if (t >= 4.4 && t < 5.25) hoverSelector = 'button[data-command="undoSend"]';
      } else {
        stateIndex = 3;
        stepLabel = '3 / 3';
        caption = 'Undo takes a send back; local files stay';
        if (t >= 6.4) hoverSelector = 'button[data-command="sendUndo"]';
      }

      return { stateIndex, stepLabel, caption, hoverSelector, ...pos, ...fx };
    },
  };

  // -------------------------------------------------------------------------
  // 4. Review files for AI agents and scripts
  // -------------------------------------------------------------------------
  const agentTexBefore = [
    '\\section{Evaluation}',
    'We report the scale-invariant SDR',
    'on the 10-hour test set.',
    '',
    '\\begin{equation}',
    '  \\mathrm{SDR} = 10\\log(\\|s\\|^2 / \\|e\\|^2)',
    '\\end{equation}',
    '',
    'All models run on identical splits.',
  ];

  const agentTexAfter = [
    '\\section{Evaluation}',
    'We report scale-invariant signal-to-distortion',
    'ratio (SDR, in dB) on the 10-hour test set.',
    '',
    '\\begin{equation}',
    '  \\mathrm{SDR} = 10\\log(\\|s\\|^2 / \\|e\\|^2)',
    '\\end{equation}',
    '',
    'All models run on identical splits.',
  ];

  const jsonBefore = [
    '{',
    '  "threadId": "t-42",',
    '  "path": "sections/method.tex",',
    '  "line": 2,',
    '  "remote": {',
    '    "author": "Hannah Lin",',
    '    "text": "Define SDR before Eq. (2)?"',
    '  },',
    '  "localEdits": []',
    '}',
  ];

  const jsonAfter = [
    '{',
    '  "threadId": "t-42",',
    '  "path": "sections/method.tex",',
    '  "line": 2,',
    '  "remote": {',
    '    "author": "Hannah Lin",',
    '    "text": "Define SDR before Eq. (2)?"',
    '  },',
    '  "localEdits": [',
    '    {',
    '      "id": "reply-1",',
    '      "action": "reply",',
    '      "text": "Defined SDR before Eq. (2)."',
    '    }',
    '  ]',
    '}',
  ];

  const sdrThread = {
    id: 't-42',
    resolved: false,
    messages: [
      {
        id: 'm-42',
        author: 'Hannah Lin',
        authorId: 'u-hannah',
        timestamp: '2026-11-18T14:18:00',
        text: 'Could you define the SDR metric before Eq. (2)?',
      },
    ],
  };

  const agentReplyText = 'Defined SDR before Eq. (2).';
  const agentDraft = {
    id: 'reply-1',
    kind: 'reply',
    path: 'sections/method.tex',
    threadId: 't-42',
    text: agentReplyText,
  };
  const agentOutgoingChange = {
    id: 'reply-1',
    draftId: 'reply-1',
    path: 'sections/method.tex',
    label: 'Reply',
    line: 2,
    before: sdrThread,
    after: {
      id: 't-42',
      resolved: false,
      messages: [
        ...sdrThread.messages,
        { id: 'draft:42', author: 'Alex Chen', authorId: 'u-alex', timestamp: '2026-11-18T14:25:00', text: agentReplyText },
      ],
    },
  };

  const agentReviewScene = {
    id: 'agent-review',
    title: 'Review files for AI agents and scripts',
    fps: 15,
    duration: 9.0,
    targetSelectors: ['button[data-command="send"]'],
    states: [
      // State 0: Reading .turnleaf/.../review/REVIEW.md & t-42.json
      {
        sidebarHtml: projectContent({
          ...baseProject,
          state: 'Up to date.',
          openComments: 1,
          suggestions: 0,
          reviewFiles: true,
          outgoing: { files: [], comments: [] },
          rows: [hannahRow(sdrThread, 2, 'scale-invariant SDR')],
        }, 'sidebar'),
        tabsHtml: renderTabBar({ title: 'sections/method.tex', secondary: 'threads/t-42.json' }),
        breadcrumbsHtml: renderBreadcrumbs(['.turnleaf', 'projects', 'review', 'threads', 't-42.json']),
        editorHtml: renderSplitAgentEditor({
          leftTabName: 'sections/method.tex',
          rightTabName: 'review/threads/t-42.json',
          leftLines: agentTexBefore,
          leftHighlights: { 2: 'scale-invariant SDR' },
          rightJsonLines: jsonBefore,
          agentLogs: [
            { status: 'running', text: 'Reading .turnleaf/.../review/REVIEW.md', detail: '1 open thread (t-42)' },
          ],
        }),
        statusText: 'Review files on · 1 open thread',
        cursorText: 'Ln 2, Col 15',
      },
      // State 1: Agent edits LaTeX source
      {
        sidebarHtml: projectContent({
          ...baseProject,
          state: 'Up to date.',
          openComments: 1,
          suggestions: 0,
          reviewFiles: true,
          outgoing: { files: [], comments: [] },
          rows: [hannahRow(sdrThread, 2, 'signal-to-distortion ratio')],
        }, 'sidebar'),
        tabsHtml: renderTabBar({ title: 'sections/method.tex', secondary: 'threads/t-42.json' }),
        breadcrumbsHtml: renderBreadcrumbs(['.turnleaf', 'projects', 'review', 'threads', 't-42.json']),
        editorHtml: renderSplitAgentEditor({
          leftTabName: 'sections/method.tex',
          rightTabName: 'review/threads/t-42.json',
          leftLines: agentTexAfter,
          leftFlashLines: [2, 3],
          leftHighlights: { 2: 'signal-to-distortion' },
          rightJsonLines: jsonBefore,
          agentLogs: [
            { status: 'done', text: 'Read .turnleaf/.../review/REVIEW.md', detail: '1 open thread (t-42)' },
            { status: 'running', text: 'Edited sections/method.tex', detail: 'defined SDR before Eq. (2)' },
          ],
        }),
        statusText: 'Saved sections/method.tex',
        cursorText: 'Ln 3, Col 18',
      },
      // State 2: Agent writes localEdits into threads/t-42.json
      {
        sidebarHtml: projectContent({
          ...baseProject,
          state: 'Up to date.',
          openComments: 1,
          suggestions: 0,
          reviewFiles: true,
          outgoing: { files: [], comments: [] },
          rows: [hannahRow(sdrThread, 2, 'signal-to-distortion ratio')],
        }, 'sidebar'),
        tabsHtml: renderTabBar({ title: 'sections/method.tex', secondary: 'threads/t-42.json' }),
        breadcrumbsHtml: renderBreadcrumbs(['.turnleaf', 'projects', 'review', 'threads', 't-42.json']),
        editorHtml: renderSplitAgentEditor({
          leftTabName: 'sections/method.tex',
          rightTabName: 'review/threads/t-42.json',
          leftLines: agentTexAfter,
          leftHighlights: { 2: 'signal-to-distortion' },
          rightJsonLines: jsonAfter,
          rightJsonFlashLines: [9, 10, 11, 12, 13, 14, 15],
          agentLogs: [
            { status: 'done', text: 'Read .turnleaf/.../review/REVIEW.md', detail: '1 open thread (t-42)' },
            { status: 'done', text: 'Edited sections/method.tex', detail: 'defined SDR before Eq. (2)' },
            { status: 'done', text: 'Queued reply in threads/t-42.json', detail: 'waiting for Send' },
          ],
        }),
        statusText: 'Imported review/threads/t-42.json',
        cursorText: 'Ln 13, Col 40',
      },
      // State 3: Turnleaf imports queue into Outgoing summary — human decides when to Send
      {
        sidebarHtml: projectContent({
          ...baseProject,
          state: '1 file and 1 comment change waiting to send.',
          openComments: 1,
          suggestions: 0,
          reviewFiles: true,
          drafts: [agentDraft],
          outgoing: {
            files: [{ path: 'sections/method.tex', added: 2, removed: 2 }],
            comments: [agentOutgoingChange],
            check: { mode: 'full', live: true },
            asOf: '14:25',
          },
          rows: [hannahRow(sdrThread, 2, 'signal-to-distortion ratio')],
        }, 'sidebar'),
        tabsHtml: renderTabBar({ title: 'sections/method.tex', secondary: 'threads/t-42.json' }),
        breadcrumbsHtml: renderBreadcrumbs(['.turnleaf', 'projects', 'review', 'threads', 't-42.json']),
        editorHtml: renderSplitAgentEditor({
          leftTabName: 'sections/method.tex',
          rightTabName: 'review/threads/t-42.json',
          leftLines: agentTexAfter,
          leftHighlights: { 2: 'signal-to-distortion' },
          rightJsonLines: jsonAfter,
          agentLogs: [
            { status: 'done', text: 'Read .turnleaf/.../review/REVIEW.md', detail: '1 open thread (t-42)' },
            { status: 'done', text: 'Edited sections/method.tex', detail: 'defined SDR before Eq. (2)' },
            { status: 'done', text: 'Queued reply in threads/t-42.json', detail: 'waiting for Send' },
          ],
        }),
        statusText: 'Queued in Outgoing summary · Send to publish',
        cursorText: 'Ln 13, Col 40',
      },
    ],
    timeline(t, byState) {
      const sendBtn = byState[3]?.['button[data-command="send"]'] ?? { x: 255, y: 185 };
      const waypoints = [
        { t: 0.0, x: 760, y: 575 },
        { t: 2.3, x: 640, y: 220 },
        { t: 3.9, x: 900, y: 310 },
        { t: 5.5, x: 900, y: 310 },
        { t: 6.7, x: sendBtn.x, y: sendBtn.y },
        { t: 9.0, x: sendBtn.x, y: sendBtn.y },
      ];
      const pos = interpolateCursor(waypoints, t);

      let stateIndex = 0;
      let stepLabel = '1 / 3';
      let caption = 'Comments kept as local JSON & Markdown';
      let hoverSelector = null;

      if (t >= 2.1 && t < 3.6) {
        stateIndex = 1;
        stepLabel = '2 / 3';
        caption = 'Agent edits source & queues localEdits';
      } else if (t >= 3.6 && t < 5.3) {
        stateIndex = 2;
        stepLabel = '2 / 3';
        caption = 'Agent edits source & queues localEdits';
      } else if (t >= 5.3) {
        stateIndex = 3;
        stepLabel = '3 / 3';
        caption = 'Queued in Outgoing summary — you choose Send';
        if (t >= 6.65) hoverSelector = 'button[data-command="send"]';
      }

      return { stateIndex, stepLabel, caption, hoverSelector, pressing: false, ripple: 0, ...pos };
    },
  };

  return [getLatestScene, commentsScene, sendAndUndoScene, agentReviewScene];
}
