// Realistic VS Code Dark Modern & Light Modern UI shell + editor renderers for Turnleaf demos.

export const VIEWPORT = { width: 1100, height: 660 };

export const THEMES = {
  dark: {
    name: 'dark',
    bodyClass: 'sidebar vscode-dark',
    vars: {
      '--vscode-foreground': '#cccccc',
      '--vscode-descriptionForeground': '#9d9d9d',
      '--vscode-sideBar-background': '#181818',
      '--vscode-editor-background': '#1f1f1f',
      '--vscode-panel-border': '#2b2b2b',
      '--vscode-list-hoverBackground': '#2a2d2e',
      '--vscode-list-inactiveSelectionBackground': '#37373d',
      '--vscode-button-background': '#0078d4',
      '--vscode-button-foreground': '#ffffff',
      '--vscode-button-border': 'transparent',
      '--vscode-button-secondaryBackground': '#313131',
      '--vscode-button-secondaryForeground': '#cccccc',
      '--vscode-button-secondaryHoverBackground': '#3c3c3c',
      '--vscode-input-background': '#252526',
      '--vscode-input-border': '#3c3c3c',
      '--vscode-input-foreground': '#cccccc',
      '--vscode-input-placeholderForeground': '#7a7a7a',
      '--vscode-dropdown-background': '#252526',
      '--vscode-dropdown-foreground': '#cccccc',
      '--vscode-dropdown-border': '#3c3c3c',
      '--vscode-focusBorder': '#0078d4',
      '--vscode-textLink-foreground': '#4daafc',
      '--vscode-textCodeBlock-background': '#181818',
      '--vscode-editorWarning-foreground': '#cca700',
      '--vscode-editorInfo-foreground': '#3794ff',
      '--vscode-turnleaf-accent': '#79b8f2',
      '--vscode-turnleaf-addedForeground': '#89c999',
      '--vscode-turnleaf-removedForeground': '#e39b9b',
      '--vscode-turnleaf-buttonBackground': '#0078d4',
      '--chrome-titlebar-bg': '#181818',
      '--chrome-activity-bg': '#181818',
      '--chrome-border': '#2b2b2b',
      '--chrome-tab-inactive-bg': '#181818',
      '--chrome-tab-active-bg': '#1f1f1f',
      '--chrome-tab-fg': '#9d9d9d',
      '--chrome-tab-active-fg': '#ffffff',
      '--chrome-search-bg': '#242424',
      '--chrome-search-border': '#333333',
      '--chrome-icon': '#858585',
      '--chrome-icon-active': '#ffffff',
      '--chrome-gutter-fg': '#6e7681',
      '--chrome-line-highlight': '#262626',
      '--chrome-statusbar-bg': '#181818',
      '--chrome-statusbar-fg': '#cccccc',
      '--chrome-statusbar-border': '#2b2b2b',
      '--chrome-statusbar-remote-bg': '#0078d4',
      '--chrome-statusbar-remote-fg': '#ffffff',
      '--chrome-comment-bg': 'rgba(121, 184, 242, 0.12)',
      '--chrome-comment-border': 'rgba(121, 184, 242, 0.48)',
      '--chrome-gutter-open': '#79b8f2',
      '--chrome-gutter-resolved': '#8b9bb0',
      '--chrome-suggest-bg': 'rgba(156, 204, 44, 0.22)',
      '--chrome-suggest-border': 'rgba(156, 204, 44, 0.55)',
      '--chrome-diff-added-line': '#203a2a',
      '--chrome-diff-removed-line': '#44272b',
      '--chrome-diff-added-text': '#315b3d',
      '--chrome-diff-removed-text': '#703c43',
      '--chrome-diff-note': '#8c929a',
      '--chrome-flash-bg': 'rgba(137, 201, 153, 0.16)',
      '--chrome-thread-bg': '#222326',
      '--chrome-thread-head-bg': '#25262a',
      '--chrome-thread-border': '#3c3c3c',
      '--chrome-panel-bg': '#181818',
      '--chrome-caption-bg': 'rgba(24, 24, 26, 0.94)',
      '--chrome-caption-border': '#3c3c42',
      '--chrome-caption-fg': '#f0f0f2',
      '--chrome-caption-badge-bg': 'rgba(121, 184, 242, 0.18)',
      '--chrome-caption-badge-fg': '#79b8f2',
      '--syn-cmd': '#569cd6',
      '--syn-env': '#4ec9b0',
      '--syn-arg': '#ce9178',
      '--syn-math': '#dcdcaa',
      '--syn-comment': '#6a9955',
      '--syn-brace': '#ffd700',
      '--syn-json-key': '#9cdcfe',
      '--syn-json-str': '#ce9178',
      '--syn-json-num': '#b5cea8',
      '--syn-json-punct': '#808080',
    },
  },
  light: {
    name: 'light',
    bodyClass: 'sidebar vscode-light',
    vars: {
      '--vscode-foreground': '#3b3b3b',
      '--vscode-descriptionForeground': '#6e6e6e',
      '--vscode-sideBar-background': '#f8f8f8',
      '--vscode-editor-background': '#ffffff',
      '--vscode-panel-border': '#e5e5e5',
      '--vscode-list-hoverBackground': '#e8e8e8',
      '--vscode-list-inactiveSelectionBackground': '#e4e6f1',
      '--vscode-button-background': '#005fb8',
      '--vscode-button-foreground': '#ffffff',
      '--vscode-button-border': 'transparent',
      '--vscode-button-secondaryBackground': '#e5e5e5',
      '--vscode-button-secondaryForeground': '#3b3b3b',
      '--vscode-button-secondaryHoverBackground': '#d6d6d6',
      '--vscode-input-background': '#ffffff',
      '--vscode-input-border': '#cecece',
      '--vscode-input-foreground': '#3b3b3b',
      '--vscode-input-placeholderForeground': '#767676',
      '--vscode-dropdown-background': '#ffffff',
      '--vscode-dropdown-foreground': '#3b3b3b',
      '--vscode-dropdown-border': '#cecece',
      '--vscode-focusBorder': '#005fb8',
      '--vscode-textLink-foreground': '#005fb8',
      '--vscode-textCodeBlock-background': '#f3f3f3',
      '--vscode-editorWarning-foreground': '#bf8803',
      '--vscode-editorInfo-foreground': '#1a85ff',
      '--vscode-turnleaf-accent': '#0069a8',
      '--vscode-turnleaf-addedForeground': '#266d40',
      '--vscode-turnleaf-removedForeground': '#a1262a',
      '--vscode-turnleaf-buttonBackground': '#005fb8',
      '--chrome-titlebar-bg': '#f8f8f8',
      '--chrome-activity-bg': '#f8f8f8',
      '--chrome-border': '#e5e5e5',
      '--chrome-tab-inactive-bg': '#f8f8f8',
      '--chrome-tab-active-bg': '#ffffff',
      '--chrome-tab-fg': '#6e6e6e',
      '--chrome-tab-active-fg': '#3b3b3b',
      '--chrome-search-bg': '#ffffff',
      '--chrome-search-border': '#d4d4d4',
      '--chrome-icon': '#6e6e6e',
      '--chrome-icon-active': '#1f1f1f',
      '--chrome-gutter-fg': '#6e7681',
      '--chrome-line-highlight': '#f3f6fa',
      '--chrome-statusbar-bg': '#f8f8f8',
      '--chrome-statusbar-fg': '#3b3b3b',
      '--chrome-statusbar-border': '#e5e5e5',
      '--chrome-statusbar-remote-bg': '#005fb8',
      '--chrome-statusbar-remote-fg': '#ffffff',
      '--chrome-comment-bg': 'rgba(0, 105, 168, 0.085)',
      '--chrome-comment-border': 'rgba(0, 105, 168, 0.42)',
      '--chrome-gutter-open': '#0069a8',
      '--chrome-gutter-resolved': '#6a7f93',
      '--chrome-suggest-bg': 'rgba(130, 185, 25, 0.22)',
      '--chrome-suggest-border': 'rgba(105, 158, 12, 0.52)',
      '--chrome-diff-added-line': '#e7f3e8',
      '--chrome-diff-removed-line': '#fbe9e9',
      '--chrome-diff-added-text': '#bde5c3',
      '--chrome-diff-removed-text': '#f4c0c0',
      '--chrome-diff-note': '#6e7681',
      '--chrome-flash-bg': '#e6f4ea',
      '--chrome-thread-bg': '#f8f9fa',
      '--chrome-thread-head-bg': '#f0f2f5',
      '--chrome-thread-border': '#d0d7de',
      '--chrome-panel-bg': '#f8f8f8',
      '--chrome-caption-bg': 'rgba(255, 255, 255, 0.96)',
      '--chrome-caption-border': '#d0d7de',
      '--chrome-caption-fg': '#1f2328',
      '--chrome-caption-badge-bg': 'rgba(0, 105, 168, 0.12)',
      '--chrome-caption-badge-fg': '#0069a8',
      '--syn-cmd': '#0000ff',
      '--syn-env': '#267f99',
      '--syn-arg': '#a31515',
      '--syn-math': '#795e26',
      '--syn-comment': '#008000',
      '--syn-brace': '#0431fa',
      '--syn-json-key': '#0451a5',
      '--syn-json-str': '#a31515',
      '--syn-json-num': '#098658',
      '--syn-json-punct': '#6e6e6e',
    },
  },
};

export const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function tokenizeLatexSlice(raw) {
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '%') {
      out += `<span class="tok-comment">${escapeHtml(raw.slice(i))}</span>`;
      break;
    }
    if (ch === '\\') {
      const m = raw.slice(i).match(/^\\([A-Za-z@]+|.)/);
      const token = m ? m[0] : '\\';
      const isEnv = /^\\(begin|end|section|subsection|cite|label|ref|eqref|usepackage|textbf|emph)$/.test(token);
      out += `<span class="${isEnv ? 'tok-env' : 'tok-cmd'}">${escapeHtml(token)}</span>`;
      i += token.length;
      continue;
    }
    if (ch === '$') {
      const end = raw.indexOf('$', i + 1);
      if (end > i) {
        const math = raw.slice(i, end + 1);
        out += `<span class="tok-math">${escapeHtml(math)}</span>`;
        i = end + 1;
        continue;
      }
    }
    if (ch === '{' || ch === '}' || ch === '[' || ch === ']') {
      out += `<span class="tok-brace">${ch}</span>`;
      i++;
      continue;
    }
    let j = i + 1;
    while (j < raw.length && !'\\$%{}[]'.includes(raw[j])) j++;
    out += escapeHtml(raw.slice(i, j));
    i = j;
  }
  return out;
}

function tokenizeJsonSlice(raw) {
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < raw.length) {
        if (raw[j] === '\\') { j += 2; continue; }
        if (raw[j] === '"') { j++; break; }
        j++;
      }
      const str = raw.slice(i, j);
      const rest = raw.slice(j);
      const isKey = /^\s*:/.test(rest);
      out += `<span class="${isKey ? 'tok-jkey' : 'tok-jstr'}">${escapeHtml(str)}</span>`;
      i = j;
      continue;
    }
    if (/[{}\[\]:,]/.test(ch)) {
      out += `<span class="tok-jpunct">${ch}</span>`;
      i++;
      continue;
    }
    const num = raw.slice(i).match(/^(true|false|null|-?\d+(?:\.\d+)?)/);
    if (num && (i === 0 || /[\s:,\[{]/.test(raw[i - 1]))) {
      out += `<span class="tok-jnum">${num[0]}</span>`;
      i += num[0].length;
      continue;
    }
    let j = i + 1;
    while (j < raw.length && !'" {}[]:,'.includes(raw[j])) j++;
    out += escapeHtml(raw.slice(i, j));
    i = j;
  }
  return out;
}

/** Split raw text around explicit substring highlights and tokenize each slice safely. */
function renderDecoratedLine(raw, spans = [], tokenizer = tokenizeLatexSlice) {
  if (!raw) return '&nbsp;';
  if (!spans.length) return tokenizer(raw);
  const resolved = [];
  for (const sp of spans) {
    if (!sp.text) continue;
    const idx = raw.indexOf(sp.text);
    if (idx >= 0) resolved.push({ start: idx, end: idx + sp.text.length, cls: sp.cls });
  }
  if (!resolved.length) return tokenizer(raw);
  resolved.sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const r of resolved) {
    if (r.start < cursor) continue;
    if (r.start > cursor) out += tokenizer(raw.slice(cursor, r.start));
    out += `<span class="${r.cls}">${tokenizer(raw.slice(r.start, r.end))}</span>`;
    cursor = r.end;
  }
  if (cursor < raw.length) out += tokenizer(raw.slice(cursor));
  return out || '&nbsp;';
}

const gutterBubbleSvg = (kind = 'open') => {
  const inner = kind === 'resolved'
    ? '<path d="M5.2 6.8 6.9 8.5 10.8 4.6" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/>'
    : '';
  return `<svg class="gutter-comment ${kind}" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 2.5h11a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6.3l-3.3 2.8v-2.8H2.5a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>${inner}</svg>`;
};

function renderAvatar(name) {
  const init = name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
  return `<span class="thread-avatar">${escapeHtml(init)}</span>`;
}

/**
 * Renders the main single-file code editor with gutter comment bubbles,
 * commented-text anchors, suggested insertions, and an optional inline native comment widget.
 */
export function renderCodeEditor({
  lines,
  commentHighlights = {},
  gutterComments = {},
  suggestions = {},
  flashLines = [],
  activeLine = 0,
  inlineThread = null,
}) {
  const flashSet = new Set(flashLines);
  const rows = [];
  for (let idx = 0; idx < lines.length; idx++) {
    const ln = idx + 1;
    const raw = lines[idx];
    const spans = [];
    if (commentHighlights[ln]) spans.push({ text: commentHighlights[ln], cls: 'comment-anchor' });
    if (suggestions[ln]) spans.push({ text: suggestions[ln], cls: 'suggest-ins' });
    const cls = [
      'code-line',
      flashSet.has(ln) ? 'line-flash' : '',
      activeLine === ln ? 'line-active' : '',
    ].filter(Boolean).join(' ');
    const gutterIcon = gutterComments[ln] ? gutterBubbleSvg(gutterComments[ln]) : '';
    rows.push(
      `<div class="${cls}" data-line="${ln}">` +
        `<span class="ln">${ln}</span>` +
        `<span class="gutter-mark">${gutterIcon}</span>` +
        `<span class="code-text">${renderDecoratedLine(raw, spans, tokenizeLatexSlice)}</span>` +
      `</div>`
    );
    if (inlineThread && inlineThread.afterLine === ln) {
      const msgs = inlineThread.messages.map((m) => `
        <div class="thread-msg">
          ${renderAvatar(m.author)}
          <div class="thread-msg-body">
            <div class="thread-msg-head">
              <strong>${escapeHtml(m.author)}</strong>
              <span class="thread-time">${escapeHtml(m.time)}</span>
              ${m.pending ? '<span class="thread-badge">Pending send</span>' : ''}
            </div>
            <div class="thread-msg-text">${escapeHtml(m.text)}</div>
          </div>
        </div>
      `).join('');
      const box = inlineThread.showReplyBox ? `
        <div class="thread-reply">
          <div class="thread-input${inlineThread.typingFocused ? ' focused' : ''}" data-demo-target="inline-reply-box">
            <span class="typed-value" data-live-text>${escapeHtml(inlineThread.typedText ?? '')}</span><span class="typing-caret${inlineThread.caretActive ? ' on' : ''}"></span><span class="placeholder"${inlineThread.typedText ? ' hidden' : ''}>Reply…</span>
          </div>
          <button type="button" class="thread-btn primary" data-demo-target="inline-reply-btn">Reply</button>
        </div>
      ` : '';
      rows.push(`
        <div class="inline-thread-wrap">
          <div class="inline-thread">
            <div class="inline-thread-head">
              <span class="thread-provider">${gutterBubbleSvg('open')}<span>Overleaf · ${escapeHtml(inlineThread.title)}</span></span>
              <span class="thread-actions">
                <span class="thread-action-pill">Resolve on send</span>
              </span>
            </div>
            <div class="inline-thread-body">${msgs}${box}</div>
          </div>
        </div>
      `);
    }
  }
  return `<div class="code-editor">${rows.join('')}</div>`;
}

/**
 * Renders a VS Code side-by-side diff editor matching Turnleaf's ReviewDiffDecorations.
 * Line objects: { ln?: number, text: string, kind?: 'added' | 'removed' | 'blank', span?: string, note?: string }
 */
export function renderDiffEditor({ leftLabel, rightLabel, leftLines, rightLines }) {
  const renderSide = (items, side) => items.map((item) => {
    if (item.kind === 'blank') {
      return `<div class="diff-line blank"><span class="ln"></span><span class="code-text">&nbsp;</span></div>`;
    }
    const lineCls = item.kind === 'added' ? ' added' : item.kind === 'removed' ? ' removed' : '';
    const spans = item.span ? [{ text: item.span, cls: item.kind === 'added' ? 'diff-added-text' : 'diff-removed-text' }] : [];
    const note = item.note ? `<span class="diff-note">${escapeHtml(item.note)}</span>` : '';
    return `<div class="diff-line${lineCls}"><span class="ln">${item.ln ?? ''}</span><span class="code-text">${renderDecoratedLine(item.text, spans, tokenizeLatexSlice)}${note}</span></div>`;
  }).join('');

  return `
    <div class="diff-editor">
      <div class="diff-pane left">
        <div class="diff-subhead">${escapeHtml(leftLabel)}</div>
        <div class="diff-lines">${renderSide(leftLines, 'left')}</div>
      </div>
      <div class="diff-pane right">
        <div class="diff-subhead">${escapeHtml(rightLabel)}</div>
        <div class="diff-lines">${renderSide(rightLines, 'right')}</div>
      </div>
    </div>
  `;
}

/**
 * Renders a split LaTeX + JSON review file editor above an integrated Agent panel.
 */
export function renderSplitAgentEditor({
  leftTabName,
  rightTabName,
  leftLines,
  leftFlashLines = [],
  leftHighlights = {},
  rightJsonLines,
  rightJsonFlashLines = [],
  agentLogs = [],
}) {
  const leftFlash = new Set(leftFlashLines);
  const rightFlash = new Set(rightJsonFlashLines);
  const renderLeft = leftLines.map((raw, i) => {
    const ln = i + 1;
    const spans = leftHighlights[ln] ? [{ text: leftHighlights[ln], cls: 'comment-anchor' }] : [];
    return `<div class="code-line compact${leftFlash.has(ln) ? ' line-flash' : ''}"><span class="ln">${ln}</span><span class="code-text">${renderDecoratedLine(raw, spans, tokenizeLatexSlice)}</span></div>`;
  }).join('');
  const renderRight = rightJsonLines.map((raw, i) => {
    const ln = i + 1;
    return `<div class="code-line compact${rightFlash.has(ln) ? ' line-flash' : ''}"><span class="ln">${ln}</span><span class="code-text">${renderDecoratedLine(raw, [], tokenizeJsonSlice)}</span></div>`;
  }).join('');
  const logsHtml = agentLogs.map((entry) => `
    <div class="agent-log ${entry.status ?? 'done'}">
      <span class="agent-glyph">${entry.status === 'running' ? '●' : '✓'}</span>
      <span class="agent-msg">${escapeHtml(entry.text)}</span>
      ${entry.detail ? `<span class="agent-detail">${escapeHtml(entry.detail)}</span>` : ''}
    </div>
  `).join('');

  return `
    <div class="split-agent-layout">
      <div class="split-editors">
        <div class="split-pane left">
          <div class="split-tabstrip">
            <span class="split-tab active">${texFileDot()}${escapeHtml(leftTabName)}</span>
          </div>
          <div class="split-code">${renderLeft}</div>
        </div>
        <div class="split-pane right">
          <div class="split-tabstrip">
            <span class="split-tab active">${jsonFileBadge()}${escapeHtml(rightTabName)}</span>
          </div>
          <div class="split-code">${renderRight}</div>
        </div>
      </div>
      <div class="bottom-panel">
        <div class="bottom-panel-tabs">
          <span class="panel-tab active">CODING AGENT</span>
          <span class="panel-tab">TERMINAL</span>
          <span class="panel-tab">OUTPUT</span>
        </div>
        <div class="bottom-panel-body">${logsHtml}</div>
      </div>
    </div>
  `;
}

function texFileDot() {
  return `<span class="file-tag tex">TeX</span>`;
}
function jsonFileBadge() {
  return `<span class="file-tag json">{}</span>`;
}

const activityIcons = {
  explorer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/><path d="M4 7v14h11"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5" stroke-linecap="round"/></svg>',
  git: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="6" r="2.2"/><circle cx="7" cy="18" r="2.2"/><circle cx="17" cy="10" r="2.2"/><path d="M7 8.2v7.6M9.2 6.5c4 0 7.8.5 7.8 1.3"/></svg>',
  ext: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><rect x="3" y="11" width="8" height="10" rx="1"/><rect x="13" y="11" width="8" height="10" rx="1"/><rect x="3" y="3" width="8" height="6" rx="1"/><rect x="14.5" y="2.5" width="7" height="7" rx="1"/></svg>',
  turnleaf: '<svg viewBox="0 0 24 24"><defs><mask id="activity-turnleaf-mask" maskUnits="userSpaceOnUse" x="-200" y="-400" width="1400" height="1600"><rect x="-200" y="-400" width="1400" height="1600" fill="#fff"/><path d="M535.0,775 L865,775 L865,300 L535.0,300 L535.0,490.0 L815,490.0 Z" fill="#000"/></mask></defs><g transform="translate(2.33,21.00) scale(0.02338,-0.02338)"><path d="M805 770 815 550H772Q768 616 748.5 652.5Q729 689 693.5 703.5Q658 718 604 718Q553 718 527.0 715.5Q501 713 493.0 706.0Q485 699 485 687V163Q485 120 494.0 93.5Q503 67 532.0 54.5Q561 42 620 40V0H201V40Q261 42 290.0 54.5Q319 67 328.5 93.5Q338 120 338 163V687Q338 699 331.0 706.0Q324 713 302.0 715.5Q280 718 235 718Q199 718 166.0 714.0Q133 710 108.0 694.5Q83 679 68.0 645.0Q53 611 51 550H12L22 770Z" fill="currentColor" mask="url(#activity-turnleaf-mask)"/><path d="M561.1,717.7 L762.7,516.1 L561.1,516.1 Z" fill="currentColor"/></g></svg>',
};

export function buildShellStyles({ themeName, panelStyle, historyStyle }) {
  const theme = THEMES[themeName];
  const varLines = Object.entries(theme.vars).map(([k, v]) => `  ${k}: ${v};`).join('\n');
  return `
:root {
${varLines}
  --vscode-font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Arial, sans-serif;
  --vscode-font-size: 12.5px;
  --vscode-editor-font-family: "SF Mono", Menlo, Monaco, Consolas, monospace;
}
${panelStyle}
${historyStyle}
/* VS Code desktop window shell & Turnleaf sidebar overrides */
* { box-sizing: border-box; }
html, body {
  margin: 0;
  padding: 0;
  width: ${VIEWPORT.width}px;
  height: ${VIEWPORT.height}px;
  overflow: hidden;
  background: var(--vscode-editor-background);
  color: var(--vscode-foreground);
  font-family: var(--vscode-font-family);
  -webkit-font-smoothing: antialiased;
}
.vscode-window {
  position: relative;
  width: ${VIEWPORT.width}px;
  height: ${VIEWPORT.height}px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  user-select: none;
}
/* Titlebar */
.titlebar {
  height: 32px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  background: var(--chrome-titlebar-bg);
  border-bottom: 1px solid var(--chrome-border);
}
.traffic-lights {
  display: flex;
  gap: 7px;
  align-items: center;
  width: 72px;
}
.traffic-light { width: 11px; height: 11px; border-radius: 50%; }
.traffic-light.red { background: #ff5f57; }
.traffic-light.yellow { background: #febc2e; }
.traffic-light.green { background: #28c840; }
.title-search {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 340px;
  height: 21px;
  border-radius: 5px;
  background: var(--chrome-search-bg);
  border: 1px solid var(--chrome-search-border);
  font-size: 11.5px;
  color: var(--vscode-descriptionForeground);
}
.title-search svg { width: 12px; height: 12px; opacity: 0.8; }
.title-right {
  width: 72px;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  color: var(--chrome-icon);
}
.title-right svg { width: 14px; height: 14px; }

/* Main horizontal split */
.workbench {
  flex: 1;
  min-height: 0;
  display: flex;
}
.activity-bar {
  width: 44px;
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-top: 6px;
  gap: 4px;
  background: var(--chrome-activity-bg);
  border-right: 1px solid var(--chrome-border);
}
.activity-item {
  position: relative;
  width: 44px;
  height: 42px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--chrome-icon);
}
.activity-item svg { width: 21px; height: 21px; }
.activity-item.active { color: var(--chrome-icon-active); }
.activity-item.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 7px;
  bottom: 7px;
  width: 2px;
  background: var(--vscode-turnleaf-accent);
  border-radius: 0 2px 2px 0;
}

/* Primary Sidebar */
.primary-sidebar {
  width: 320px;
  flex: none;
  display: flex;
  flex-direction: column;
  background: var(--vscode-sideBar-background);
  border-right: 1px solid var(--chrome-border);
  overflow: hidden;
}
.sidebar-view-head {
  height: 34px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px 0 14px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.05em;
  color: var(--vscode-descriptionForeground);
}
.sidebar-view-actions {
  display: flex;
  gap: 8px;
  color: var(--chrome-icon);
}
.sidebar-view-actions svg { width: 14px; height: 14px; }
#turnleaf-sidebar {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
/* Override panelStyle.ts @media(min-width:600px) rules that assume a 600px+ webview */
#turnleaf-sidebar main { min-height: 0; }
#turnleaf-sidebar .project-header { padding: 8px 14px 10px; }
#turnleaf-sidebar .status { margin-top: 8px; padding: 7px 9px; }
#turnleaf-sidebar .actions { margin-top: 8px; }
#turnleaf-sidebar .main-actions .button { flex: 1 1 auto; min-height: 28px; padding: 5px 8px; font-size: 12px; }
#turnleaf-sidebar .outgoing-summary { padding: 0 14px 10px; }
#turnleaf-sidebar .section { padding: 10px 14px 12px; }
#turnleaf-sidebar .setup { padding: 10px 14px; }
#turnleaf-sidebar .sync-pane { padding: 10px 14px; }
#turnleaf-sidebar .tabs { position: static; padding: 0 14px; }
#turnleaf-sidebar .tab { padding: 7px 2px; }
#turnleaf-sidebar .file-list { margin: 7px -4px; }
#turnleaf-sidebar .file-button { padding: 6px 5px; }
#turnleaf-sidebar .card { margin: 6px 0; padding: 8px 9px; }
#turnleaf-sidebar .card-text { line-height: 1.4; font-size: 12px; }
#turnleaf-sidebar .filter-row { margin-bottom: 8px; }
#turnleaf-sidebar .filter-chips { margin: -2px 0 8px; }
#turnleaf-sidebar .review-bar { margin-bottom: 6px; }
#turnleaf-sidebar .summary-group { margin-top: 4px; }
#turnleaf-sidebar .summary-group > summary { padding: 6px 8px; }
#turnleaf-sidebar .group-body { padding: 0 8px 7px; }
#turnleaf-sidebar .out-row > summary { padding: 5px 1px; }
#turnleaf-sidebar .send-check > p.muted:first-child { margin: 6px 0 2px; }
#turnleaf-sidebar .summary-foot { margin-top: 5px; font-size: 11px; }
#turnleaf-sidebar .outgoing-summary > .actions { margin-top: 5px; }

/* Subtle simulated hover/click highlight on target buttons */
#turnleaf-sidebar .button.demo-hover:not(.primary) { background: var(--secondary-hover); }
#turnleaf-sidebar .button.primary.demo-hover { filter: brightness(1.1); }
#turnleaf-sidebar .button.small.demo-hover { background: var(--hover); }
#turnleaf-sidebar .icon-button.demo-hover { background: var(--hover); color: var(--vscode-foreground); }
#turnleaf-sidebar .icon-button.decide.accept.demo-hover { color: var(--added); }
#turnleaf-sidebar .card-main.demo-hover strong { text-decoration: underline; }

/* Editor Group */
.editor-group {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--vscode-editor-background);
}
.editor-tabs {
  height: 34px;
  flex: none;
  display: flex;
  align-items: stretch;
  background: var(--chrome-tab-inactive-bg);
  border-bottom: 1px solid var(--chrome-border);
}
.editor-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 12px;
  font-size: 12px;
  color: var(--chrome-tab-fg);
  border-right: 1px solid var(--chrome-border);
}
.editor-tab.active {
  background: var(--chrome-tab-active-bg);
  color: var(--chrome-tab-active-fg);
  border-top: 1px solid var(--vscode-turnleaf-accent);
}
.file-tag {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: -0.02em;
  padding: 0 3px;
  border-radius: 3px;
}
.file-tag.tex { color: #3fb950; }
.file-tag.json { color: #e3b341; }
.diff-badge {
  font-size: 10.5px;
  padding: 1px 6px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--vscode-turnleaf-accent) 16%, transparent);
  color: var(--vscode-turnleaf-accent);
  font-weight: 500;
}
.breadcrumbs {
  height: 22px;
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 14px;
  font-size: 11.5px;
  color: var(--vscode-descriptionForeground);
  background: var(--vscode-editor-background);
  border-bottom: 1px solid color-mix(in srgb, var(--chrome-border) 55%, transparent);
}
.editor-body {
  flex: 1;
  min-height: 0;
  position: relative;
  overflow: hidden;
  background: var(--vscode-editor-background);
}

/* Code & Diff Typography */
.code-editor, .diff-lines, .split-code {
  font-family: var(--vscode-editor-font-family);
  font-size: 12.2px;
  line-height: 1.72;
}
.code-editor { padding: 10px 0; }
.code-line {
  display: flex;
  align-items: baseline;
  padding: 0 14px 0 6px;
  white-space: pre;
}
.code-line.compact {
  font-size: 11.6px;
  line-height: 1.66;
  padding: 0 10px 0 4px;
}
.code-line.line-active { background: var(--chrome-line-highlight); }
.code-line.line-flash { background: var(--chrome-flash-bg); }
.code-line .ln, .diff-line .ln {
  width: 28px;
  flex: none;
  text-align: right;
  padding-right: 8px;
  color: var(--chrome-gutter-fg);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.code-line .gutter-mark {
  width: 20px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  align-self: center;
}
.gutter-comment { width: 13px; height: 13px; }
.gutter-comment.open { color: var(--chrome-gutter-open); }
.gutter-comment.resolved { color: var(--chrome-gutter-resolved); }
.code-text { flex: 1; min-width: 0; }

/* Syntax tokens */
.tok-cmd { color: var(--syn-cmd); }
.tok-env { color: var(--syn-env); }
.tok-arg { color: var(--syn-arg); }
.tok-math { color: var(--syn-math); }
.tok-comment { color: var(--syn-comment); font-style: italic; }
.tok-brace { color: var(--syn-brace); }
.tok-jkey { color: var(--syn-json-key); }
.tok-jstr { color: var(--syn-json-str); }
.tok-jnum { color: var(--syn-json-num); }
.tok-jpunct { color: var(--syn-json-punct); }

/* Turnleaf Editor Decorations */
.comment-anchor {
  background: var(--chrome-comment-bg);
  border-bottom: 1.5px solid var(--chrome-comment-border);
  border-radius: 2px 2px 0 0;
  padding: 1px 0;
}
.suggest-ins {
  background: var(--chrome-suggest-bg);
  border-bottom: 1.5px solid var(--chrome-suggest-border);
  border-radius: 2px;
  padding: 1px 0;
}

/* Native Inline Comment Thread Widget */
.inline-thread-wrap {
  padding: 5px 18px 8px 54px;
}
.inline-thread {
  border: 1px solid var(--chrome-thread-border);
  border-radius: 6px;
  background: var(--chrome-thread-bg);
  overflow: hidden;
  box-shadow: 0 3px 12px rgba(0, 0, 0, 0.14);
}
.inline-thread-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  background: var(--chrome-thread-head-bg);
  border-bottom: 1px solid var(--chrome-thread-border);
  font-size: 11.5px;
  font-weight: 500;
}
.thread-provider {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.thread-action-pill {
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 4px;
  border: 1px solid var(--chrome-thread-border);
  color: var(--vscode-descriptionForeground);
}
.inline-thread-body { padding: 8px 10px; display: flex; flex-direction: column; gap: 8px; }
.thread-msg { display: flex; gap: 8px; align-items: flex-start; }
.thread-avatar {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 600;
  background: color-mix(in srgb, var(--vscode-foreground) 14%, transparent);
}
.thread-msg-body { flex: 1; min-width: 0; font-size: 12px; }
.thread-msg-head { display: flex; align-items: center; gap: 6px; }
.thread-msg-head strong { font-weight: 600; font-size: 12px; }
.thread-time { font-size: 11px; color: var(--vscode-descriptionForeground); }
.thread-badge {
  font-size: 10px;
  padding: 0 6px;
  border-radius: 8px;
  border: 1px solid var(--vscode-turnleaf-accent);
  color: var(--vscode-turnleaf-accent);
}
.thread-msg-text { margin-top: 2px; line-height: 1.45; }
.thread-reply {
  display: flex;
  gap: 6px;
  align-items: center;
  padding-top: 4px;
  border-top: 1px solid color-mix(in srgb, var(--chrome-thread-border) 60%, transparent);
}
.thread-input {
  flex: 1;
  min-height: 26px;
  padding: 4px 8px;
  border-radius: 4px;
  border: 1px solid var(--vscode-input-border);
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  font-size: 12px;
  display: flex;
  align-items: center;
}
.thread-input.focused { border-color: var(--vscode-focusBorder); }
.thread-input .placeholder { color: var(--vscode-input-placeholderForeground); }
.typing-caret {
  display: none;
  width: 1.5px;
  height: 14px;
  margin-left: 1px;
  background: var(--vscode-foreground);
}
.typing-caret.on { display: inline-block; }
.thread-btn {
  height: 26px;
  padding: 0 10px;
  border-radius: 4px;
  border: 0;
  font-size: 12px;
  font-weight: 500;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}
.thread-btn.demo-hover { filter: brightness(1.12); }

/* Side-by-side Diff Editor */
.diff-editor {
  display: flex;
  height: 100%;
  width: 100%;
}
.diff-pane {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.diff-pane.left { border-right: 1px solid var(--chrome-border); }
.diff-subhead {
  height: 24px;
  flex: none;
  display: flex;
  align-items: center;
  padding: 0 12px;
  font-size: 11px;
  font-weight: 600;
  color: var(--vscode-descriptionForeground);
  background: color-mix(in srgb, var(--vscode-sideBar-background) 65%, var(--vscode-editor-background));
  border-bottom: 1px solid var(--chrome-border);
}
.diff-lines { padding: 8px 0; overflow: hidden; }
.diff-line {
  display: flex;
  align-items: baseline;
  padding: 0 8px 0 4px;
  white-space: pre;
  font-size: 11.4px;
  line-height: 1.68;
}
.diff-line .ln { width: 24px; padding-right: 7px; }
.diff-line.added { background: var(--chrome-diff-added-line); }
.diff-line.removed { background: var(--chrome-diff-removed-line); }
.diff-line.blank { opacity: 0.45; }
.diff-added-text { background: var(--chrome-diff-added-text); border-radius: 2px; }
.diff-removed-text { background: var(--chrome-diff-removed-text); border-radius: 2px; }
.diff-note {
  margin-left: 14px;
  font-style: italic;
  font-size: 10.6px;
  color: var(--chrome-diff-note);
}

/* Split LaTeX + JSON & Bottom Agent Panel */
.split-agent-layout {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.split-editors {
  flex: 1;
  min-height: 0;
  display: flex;
}
.split-pane {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.split-pane.left { border-right: 1px solid var(--chrome-border); }
.split-tabstrip {
  height: 28px;
  flex: none;
  display: flex;
  align-items: stretch;
  background: var(--chrome-tab-inactive-bg);
  border-bottom: 1px solid var(--chrome-border);
}
.split-tab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 10px;
  font-size: 11.5px;
  background: var(--chrome-tab-active-bg);
  color: var(--chrome-tab-active-fg);
  border-right: 1px solid var(--chrome-border);
  border-top: 1px solid var(--vscode-turnleaf-accent);
}
.split-code { padding: 8px 0; overflow: hidden; flex: 1; }
.bottom-panel {
  height: 132px;
  flex: none;
  display: flex;
  flex-direction: column;
  background: var(--chrome-panel-bg);
  border-top: 1px solid var(--chrome-border);
}
.bottom-panel-tabs {
  height: 28px;
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 0 14px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--vscode-descriptionForeground);
  border-bottom: 1px solid var(--chrome-border);
}
.panel-tab.active {
  color: var(--vscode-foreground);
  border-bottom: 1.5px solid var(--vscode-turnleaf-accent);
  padding: 6px 0;
}
.bottom-panel-body {
  flex: 1;
  padding: 8px 14px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 11.8px;
}
.agent-log {
  display: flex;
  align-items: center;
  gap: 8px;
}
.agent-glyph {
  font-size: 11px;
  color: var(--vscode-turnleaf-addedForeground);
}
.agent-log.running .agent-glyph { color: var(--vscode-turnleaf-accent); }
.agent-msg { color: var(--vscode-foreground); }
.agent-detail {
  color: var(--vscode-descriptionForeground);
  font-family: var(--vscode-editor-font-family);
  font-size: 11px;
}

/* Status Bar */
.statusbar {
  height: 22px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--chrome-statusbar-bg);
  color: var(--chrome-statusbar-fg);
  border-top: 1px solid var(--chrome-statusbar-border);
  font-size: 11px;
}
.status-left, .status-right {
  display: flex;
  align-items: center;
  height: 100%;
}
.status-remote {
  height: 100%;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 10px;
  background: var(--chrome-statusbar-remote-bg);
  color: var(--chrome-statusbar-remote-fg);
  font-weight: 500;
}
.status-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 9px;
  color: var(--vscode-descriptionForeground);
}
.status-item strong { font-weight: 500; color: var(--vscode-foreground); }

/* Animated Cursor, Ripple, & Caption Pill */
#demo-cursor {
  position: fixed;
  top: 0;
  left: 0;
  width: 22px;
  height: 24px;
  pointer-events: none;
  z-index: 9999;
  transform: translate3d(-100px, -100px, 0);
  transform-origin: 3px 2px;
  filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.38));
}
#demo-cursor.pressing {
  transform: translate3d(var(--cx, 0px), var(--cy, 0px), 0) scale(0.88);
}
#demo-ripple {
  position: fixed;
  top: 0;
  left: 0;
  width: 28px;
  height: 28px;
  margin: -14px 0 0 -14px;
  border-radius: 50%;
  border: 2px solid var(--vscode-turnleaf-accent);
  pointer-events: none;
  z-index: 9998;
  opacity: 0;
}
#demo-caption {
  position: fixed;
  right: 16px;
  bottom: 34px;
  z-index: 9990;
  pointer-events: none;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px 6px 8px;
  border-radius: 999px;
  background: var(--chrome-caption-bg);
  border: 1px solid var(--chrome-caption-border);
  color: var(--chrome-caption-fg);
  font-size: 12px;
  font-weight: 500;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.22);
}
.caption-step {
  font-size: 11px;
  font-weight: 600;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--chrome-caption-badge-bg);
  color: var(--chrome-caption-badge-fg);
  font-variant-numeric: tabular-nums;
}
`;
}

export function renderWindowHtml({
  themeName,
  panelStyle,
  historyStyle,
  projectName = 'Spatial Audio Paper',
  states,
}) {
  const theme = THEMES[themeName];
  const css = buildShellStyles({ themeName, panelStyle, historyStyle });
  const serializedStates = JSON.stringify(states);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>${css}</style>
</head>
<body class="${theme.bodyClass}">
<div class="vscode-window">
  <header class="titlebar">
    <div class="traffic-lights">
      <span class="traffic-light red"></span>
      <span class="traffic-light yellow"></span>
      <span class="traffic-light green"></span>
    </div>
    <div class="title-search">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3" stroke-linecap="round"/></svg>
      <span>${escapeHtml(projectName)}</span>
    </div>
    <div class="title-right">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="2" y="2.5" width="12" height="11" rx="1.2"/><path d="M6 2.5v11"/></svg>
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="2" y="2.5" width="12" height="11" rx="1.2"/><path d="M2 10h12"/></svg>
    </div>
  </header>
  <div class="workbench">
    <nav class="activity-bar" aria-label="Activity Bar">
      <div class="activity-item">${activityIcons.explorer}</div>
      <div class="activity-item">${activityIcons.search}</div>
      <div class="activity-item">${activityIcons.git}</div>
      <div class="activity-item">${activityIcons.ext}</div>
      <div class="activity-item active">${activityIcons.turnleaf}</div>
    </nav>
    <aside class="primary-sidebar">
      <div class="sidebar-view-head">
        <span>TURNLEAF</span>
        <span class="sidebar-view-actions">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M13 6a5 5 0 1 0 .1 4M13 2v4H9"/></svg>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M6 2H2v4m8-4h4v4M2 10v4h4m8-4v4h-4"/></svg>
        </span>
      </div>
      <div id="turnleaf-sidebar"><main id="project"></main></div>
    </aside>
    <section class="editor-group">
      <div class="editor-tabs" id="editor-tabs"></div>
      <div class="breadcrumbs" id="editor-breadcrumbs"></div>
      <div class="editor-body" id="editor-body"></div>
    </section>
  </div>
  <footer class="statusbar">
    <div class="status-left">
      <span class="status-remote">Turnleaf</span>
      <span class="status-item" id="status-sync"></span>
    </div>
    <div class="status-right">
      <span class="status-item" id="status-cursor">Ln 8, Col 18</span>
      <span class="status-item">UTF-8</span>
      <span class="status-item">LaTeX</span>
    </div>
  </footer>
</div>

<div id="demo-ripple"></div>
<svg id="demo-cursor" viewBox="0 0 24 26">
  <path d="M3 2L3 20.5L7.8 15.8L11.2 23.2L13.9 22L10.4 14.7L17.2 14.7Z" fill="#111111" stroke="#ffffff" stroke-width="1.6" stroke-linejoin="round"/>
</svg>
<div id="demo-caption"><span class="caption-step" id="cap-step"></span><span id="cap-text"></span></div>

<script>
(() => {
const STATES = ${serializedStates};
let currentState = -1;

function resolveTargetPoint(selector) {
  if (!selector) return null;
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width * 0.5, y: r.top + r.height * 0.5, el };
}

window.__measureTargets = function(selectors) {
  const out = {};
  for (const sel of selectors) out[sel] = resolveTargetPoint(sel);
  return out;
};

window.__applyFrame = function(frame) {
  if (frame.stateIndex !== currentState) {
    currentState = frame.stateIndex;
    const st = STATES[currentState];
    document.getElementById('project').innerHTML = st.sidebarHtml;
    document.getElementById('editor-tabs').innerHTML = st.tabsHtml;
    document.getElementById('editor-breadcrumbs').innerHTML = st.breadcrumbsHtml;
    document.getElementById('editor-body').innerHTML = st.editorHtml;
    document.getElementById('status-sync').textContent = st.statusText;
    document.getElementById('status-cursor').textContent = st.cursorText || 'Ln 8, Col 18';
  }

  // Hover highlight
  document.querySelectorAll('.demo-hover').forEach(n => n.classList.remove('demo-hover'));
  if (frame.hoverSelector) {
    const h = document.querySelector(frame.hoverSelector);
    if (h) h.classList.add('demo-hover');
  }

  // Live typing inside inline comment reply box
  if (frame.typedText !== undefined) {
    const live = document.querySelector('[data-live-text]');
    const box = document.querySelector('[data-demo-target="inline-reply-box"]');
    if (live && box) {
      live.textContent = frame.typedText;
      const ph = box.querySelector('.placeholder');
      if (ph) ph.hidden = frame.typedText.length > 0;
      const caret = box.querySelector('.typing-caret');
      if (caret) caret.classList.toggle('on', !!frame.caretOn);
      box.classList.toggle('focused', !!frame.inputFocused);
    }
  }

  // Caption
  document.getElementById('cap-step').textContent = frame.stepLabel;
  document.getElementById('cap-text').textContent = frame.caption;

  // Cursor (SVG arrow tip is at 3,2)
  let cx = frame.x, cy = frame.y;
  if (frame.anchorSelector) {
    const pt = resolveTargetPoint(frame.anchorSelector);
    if (pt) { cx = pt.x + (frame.dx || 0); cy = pt.y + (frame.dy || 0); }
  }
  const cursor = document.getElementById('demo-cursor');
  const scale = frame.pressing ? 0.88 : 1;
  cursor.style.transform = 'translate3d(' + (cx - 3).toFixed(1) + 'px, ' + (cy - 2).toFixed(1) + 'px, 0) scale(' + scale + ')';

  // Click ripple
  const ripple = document.getElementById('demo-ripple');
  if (frame.ripple > 0 && frame.ripple < 1) {
    const rx = frame.rippleX ?? cx;
    const ry = frame.rippleY ?? cy;
    const rs = 0.4 + frame.ripple * 1.1;
    ripple.style.opacity = (1 - frame.ripple).toFixed(3);
    ripple.style.transform = 'translate3d(' + rx.toFixed(1) + 'px, ' + ry.toFixed(1) + 'px, 0) scale(' + rs.toFixed(2) + ')';
  } else {
    ripple.style.opacity = '0';
  }
};
})();
</script>
</body>
</html>`;
}

export function renderTabBar({ title, diffLabel, secondary }) {
  return `
    <div class="editor-tab active">
      ${texFileDot()}
      <span>${escapeHtml(title)}</span>
      ${diffLabel ? `<span class="diff-badge">${escapeHtml(diffLabel)}</span>` : ''}
    </div>
    ${secondary ? `<div class="editor-tab">${texFileDot()}<span>${escapeHtml(secondary)}</span></div>` : ''}
  `;
}

export function renderBreadcrumbs(parts) {
  return parts.map((p, i) => `${i > 0 ? '<span aria-hidden="true">›</span>' : ''}<span>${escapeHtml(p)}</span>`).join('');
}
