export const panelStyle = `
:root{
  --accent:var(--vscode-turnleaf-accent,#79b8f2);
  --added:var(--vscode-turnleaf-addedForeground,#89c999);
  --removed:var(--vscode-turnleaf-removedForeground,#e39b9b);
  --line:var(--vscode-panel-border,#454549);
  --dim:var(--vscode-descriptionForeground,#a0a0a7);
  --hover:var(--vscode-list-hoverBackground,#333338);
  --card:var(--vscode-editor-background,#1f1f1f);
  --secondary:var(--vscode-button-secondaryBackground,#3a3d41);
  --secondary-fg:var(--vscode-button-secondaryForeground,#cccccc);
  --secondary-hover:var(--vscode-button-secondaryHoverBackground,#45494e);
  --fg:var(--vscode-foreground);
  --warn:var(--vscode-editorWarning-foreground);
  --primary:var(--vscode-turnleaf-buttonBackground,var(--vscode-button-background,#0e639c));
  --quiet-line:color-mix(in srgb,var(--fg) 22%,transparent);
  --tint:color-mix(in srgb,var(--fg) 6%,transparent);
}
*{box-sizing:border-box}
body{margin:0;padding:0;color:var(--vscode-foreground);background:var(--vscode-sideBar-background);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size,13px);line-height:1.5}
body.panel{background:var(--vscode-editor-background)}
body.vscode-light{--accent:var(--vscode-turnleaf-accent,#0069a8);--added:var(--vscode-turnleaf-addedForeground,#266d40);--removed:var(--vscode-turnleaf-removedForeground,#a1262a);--card:var(--vscode-editor-background,#ffffff)}
body.vscode-high-contrast,body.vscode-high-contrast-light{--line:var(--vscode-contrastBorder)}
main{min-height:100vh;display:flex;flex-direction:column}
h1,h2,h3,p{margin:0;overflow-wrap:anywhere}h1{font-size:14px;font-weight:600;line-height:1.4;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}h2{font-size:1em;font-weight:600}h3{font-size:12px;font-weight:600;margin-top:16px;color:var(--fg)}
button,select,textarea{font:inherit}button{cursor:pointer}button:disabled{opacity:.5;cursor:default}
button:focus-visible,summary:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:1px}
.icon{width:16px;height:16px;flex-shrink:0;vertical-align:middle}
.project-header{padding:12px 16px 14px}.project-title{display:flex;gap:8px;justify-content:space-between;align-items:center}.brand-mark{flex:none;display:block}.project-title h1{flex:1}
/* Status block: the sync state is the first thing under the title; its icon and tint follow the kind of state. */
.status{display:flex;gap:9px;align-items:flex-start;margin-top:10px;padding:9px 11px;border-radius:6px;background:var(--tint);border:1px solid transparent}
.status>.icon{width:18px;height:18px;margin-top:1px;stroke-width:1.5;color:var(--dim)}.status-text{min-width:0;flex:1}
.state{font-size:13px;line-height:1.4;font-weight:500}.connection{margin-top:2px;font-size:11px;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.status-synced>.icon{color:var(--added)}
.status-unsent,.status-incoming,.status-review{background:color-mix(in srgb,var(--accent) 12%,transparent);border-color:color-mix(in srgb,var(--accent) 35%,transparent)}
.status-unsent>.icon,.status-incoming>.icon,.status-review>.icon{color:var(--accent)}
.status-warning{background:color-mix(in srgb,var(--warn) 12%,transparent);border-color:color-mix(in srgb,var(--warn) 45%,transparent)}.status-warning>.icon{color:var(--warn)}
.button{display:inline-flex;gap:6px;align-items:center;justify-content:center;border:1px solid var(--vscode-button-border,transparent);border-radius:4px;padding:5px 10px;min-height:28px;color:var(--secondary-fg);background:var(--secondary);text-align:center;white-space:nowrap}
.button:hover:not(:disabled){background:var(--secondary-hover)}
.button.primary{background:var(--primary);color:var(--vscode-button-foreground,#fff)}.button.primary:hover:not(:disabled){filter:brightness(1.12)}
/* Small actions are outlined, so the main actions and the cards carry the weight. */
.button.small{min-height:24px;padding:2px 8px;font-size:12px;gap:5px;background:transparent;border-color:var(--quiet-line);color:var(--fg)}.button.small:hover:not(:disabled){background:var(--hover)}.button.small .icon{width:14px;height:14px}
.button.ghost{background:transparent;border-color:transparent;color:var(--accent);padding-left:0;padding-right:0}.button.ghost:hover:not(:disabled){background:transparent;text-decoration:underline}
.button-label{overflow:hidden;text-overflow:ellipsis}
.push-right{margin-left:auto}
.actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:10px}.main-actions{gap:8px}.main-actions .button{flex:1 1 auto;min-width:0;min-height:32px;padding:6px 8px;font-size:12px;font-weight:500}
.icon-button{background:transparent;color:var(--dim);border:0;border-radius:4px;display:inline-flex;align-items:center;justify-content:center;padding:4px;flex:none}.icon-button:hover:not(:disabled){color:var(--vscode-foreground);background:var(--hover)}.icon-button[aria-pressed=true]{color:var(--accent)}
.decide.accept:hover:not(:disabled),.decide.accept[aria-pressed=true]{color:var(--added)}
.decide.reject:hover:not(:disabled),.decide.reject[aria-pressed=true]{color:var(--removed)}
.decide[aria-pressed=true]{background:var(--hover)}
.decide-all.accept:hover:not(:disabled){color:var(--added)}.decide-all.reject:hover:not(:disabled){color:var(--removed)}
.switch{display:inline-flex;align-items:center;gap:6px;background:transparent;border:0;border-radius:4px;padding:3px 6px;color:var(--dim);font-size:12px}.switch:hover:not(:disabled){color:var(--vscode-foreground);background:var(--hover)}
.switch .track{position:relative;width:24px;height:14px;border-radius:7px;background:var(--secondary);border:1px solid var(--line);transition:background .12s}.switch .thumb{position:absolute;top:1px;left:1px;width:10px;height:10px;border-radius:50%;background:var(--dim);transition:transform .12s}
.switch[aria-checked=true]{color:var(--vscode-foreground)}.switch[aria-checked=true] .track{background:color-mix(in srgb,var(--accent) 45%,transparent);border-color:var(--accent)}.switch[aria-checked=true] .thumb{transform:translateX(10px);background:var(--vscode-button-foreground,#fff)}
@media(prefers-reduced-motion:reduce){.switch .track,.switch .thumb{transition:none}}
.bulk{display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin:8px 0 2px}.bulk .meta{margin-right:auto}.bulk .button.small{padding:2px 7px}
.card-tools{display:flex;justify-content:flex-end;gap:2px;margin-top:4px}
.muted{font-size:12px;color:var(--dim)}
.summary-counts{display:flex;gap:10px;white-space:nowrap;font-size:12px;color:var(--dim)}.summary-counts span{display:inline-flex;align-items:center;gap:5px}
.section{border-top:1px solid var(--line);padding:12px 16px 14px}.section-title{display:flex;align-items:center;gap:8px;justify-content:space-between;margin-bottom:10px}.section-title .icon{color:var(--accent)}.section-title h2{display:flex;align-items:center;gap:7px}
.title-actions{display:flex;align-items:center;gap:4px}
.review-bar{margin-bottom:8px}.review-bar .icon{color:var(--dim)}.review-bar .button .icon{color:inherit}
.filter-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:10px}.filter-row .segmented{flex:1 1 150px;margin:0}.filter-row .switch{margin-left:auto}
.filter-chips{display:flex;flex-wrap:wrap;gap:4px;margin:-4px 0 10px}.filter-chip{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--line);border-radius:11px;background:transparent;color:var(--dim);padding:1px 9px;font-size:11px}.filter-chip[aria-pressed=true]{background:var(--secondary);color:var(--secondary-fg);border-color:transparent}.filter-chip:hover:not([aria-pressed=true]):not(:disabled){color:var(--vscode-foreground)}.filter-chip .n{font-variant-numeric:tabular-nums;opacity:.75}
.agent-files{padding:9px 0 2px;border-top:1px solid var(--line);margin-top:9px}.agent-files .step-heading .switch{margin-left:auto}.agent-files .step-content{padding-left:0}
.notice{padding:10px 11px;background:var(--card);border-left:3px solid var(--warn);border-radius:0 4px 4px 0;margin:10px 0;font-size:12px}.notice p{margin-bottom:8px}
.direction{display:flex;gap:6px;align-items:center;flex-wrap:wrap;color:var(--dim);font-size:12px;margin:6px 0 10px}.direction strong{font-weight:500;color:var(--vscode-foreground)}
.file-list{padding:0;list-style:none;margin:10px -5px}.file-list>li+li{margin-top:3px}.file-list .actions,.file-list>li>.muted{margin-left:5px;margin-right:5px}.file-button{width:100%;display:flex;align-items:center;gap:8px;background:transparent;color:var(--vscode-foreground);border:0;border-radius:4px;padding:8px 5px;text-align:left}.file-button:hover{background:var(--hover)}.file-button[aria-pressed=true]{background:var(--vscode-list-inactiveSelectionBackground)}.file-name{overflow-wrap:break-word;min-width:0;flex:1}.counts{display:inline-flex;gap:8px;white-space:nowrap;font-variant-numeric:tabular-nums;font-size:12px}.added{color:var(--added)}.removed{color:var(--removed)}.strike{text-decoration:line-through}.conflict{color:var(--vscode-editorWarning-foreground);font-size:12px}
.file-list .actions .button.small{background:var(--secondary);color:var(--secondary-fg);border-color:var(--vscode-button-border,transparent)}.file-list .actions .button.small:hover:not(:disabled){background:var(--secondary-hover)}
.file-button>.button-label{display:contents}.review-details{margin-top:10px}
/* Outgoing summary: what the next Send writes, always in view between the header and the tabs. */
.outgoing-summary{padding:0 16px 12px;font-size:12px}.outgoing-summary.recomputing .summary-group,.outgoing-summary.recomputing .summary-head{opacity:.6}
.summary-head{display:flex;align-items:center;gap:7px;padding:4px 0;color:var(--dim)}.summary-head strong{font-weight:500;color:var(--fg)}.summary-head>.icon{color:var(--added)}
.summary-line{display:flex;align-items:flex-start;gap:7px;margin:0 0 6px;line-height:1.4}.summary-line>.icon{margin-top:1px;color:var(--dim)}.summary-line.attention>.icon{color:var(--warn)}
.summary-group{border:1px solid var(--line);border-radius:6px;background:var(--card);margin-top:6px}
.summary-group>summary{display:flex;align-items:flex-start;gap:7px;padding:7px 9px;cursor:pointer;list-style:none;border-radius:6px}.summary-group>summary::-webkit-details-marker{display:none}
.summary-group>summary:hover{background:var(--hover)}.summary-group>summary>.icon{margin-top:1px;color:var(--accent)}
.summary-group>summary::after{content:'';flex:none;width:6px;height:6px;margin:5px 2px 0 auto;border-right:1.5px solid var(--dim);border-bottom:1.5px solid var(--dim);transform:rotate(-45deg);transition:transform .12s}.summary-group[open]>summary::after{transform:rotate(45deg)}
.group-head{min-width:0;color:var(--dim);line-height:1.45}.group-head strong{font-weight:600;color:var(--fg)}.group-head .counts{margin-left:3px;white-space:nowrap}.group-head .counts span+span{margin-left:4px}
.cannot-undo{color:var(--warn);white-space:nowrap}
.group-body{padding:0 9px 8px;border-top:1px solid var(--line)}.group-body>.muted{margin-top:7px}.group-body .file-list{margin:6px -4px 2px}.group-body .file-button{padding:5px 5px}
.out-row{border-top:1px solid var(--line)}.group-body>.out-row:first-child{border-top:0}.file-list+.out-row{margin-top:4px}
.out-row>summary{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;padding:6px 1px;cursor:pointer;list-style:none}.out-row>summary::-webkit-details-marker{display:none}.out-row>summary:hover .out-label{text-decoration:underline}
.out-label{font-weight:500}.out-words{flex:1 1 100%;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.out-row .comment-change{margin:2px 0 8px}
.row-mark{display:inline-flex;color:var(--warn)}.row-mark .icon{width:14px;height:14px}
.row-reason{margin:0 5px 4px 29px;font-size:11px;color:var(--warn)}.out-row>summary>.row-reason{flex:1 1 100%;display:flex;align-items:center;gap:5px;margin:0}
.row-changed{box-shadow:inset 2px 0 0 var(--warn);padding-left:6px}
.stay-list{list-style:none;margin:6px 0 0;padding:0}.stay-list>li{padding:5px 0;border-top:1px solid var(--line)}.stay-list>li:first-child{border-top:0}.stay-list strong{font-weight:500}
.summary-foot{display:flex;align-items:center;gap:6px;margin-top:7px}.summary-foot .icon{width:14px;height:14px}
.outgoing-summary>.actions{margin-top:6px}
.undo-link{flex:none;min-height:22px;font-size:12px}
.card.blocking{border-color:var(--warn);box-shadow:inset 3px 0 0 var(--warn)}
@media(prefers-reduced-motion:reduce){.summary-group>summary::after,.reply-count::after{transition:none}}
.segmented{display:flex;border:1px solid var(--line);border-radius:5px;padding:2px;gap:2px;margin:0 0 10px}.segment{flex:1;border:0;border-radius:3px;background:transparent;color:var(--dim);padding:3px 0;font-size:12px}.segment[aria-pressed=true]{background:var(--secondary);color:var(--secondary-fg)}.segment:hover:not([aria-pressed=true]){color:var(--vscode-foreground)}
.send-check>p.muted:first-child{margin:8px 0 2px;font-size:11px}.send-check .segmented{margin:0 0 2px}.send-check .segment:disabled{opacity:.5}
.file-heading{display:flex;align-items:center;gap:7px;margin:12px 0 4px;font-weight:500;font-size:12px;color:var(--dim);overflow-wrap:anywhere}
.card{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:9px 10px;margin:6px 0}
.card.selected{border-color:var(--accent);box-shadow:inset 3px 0 0 var(--accent)}.card.resolved{opacity:.75}
.card.change{padding:7px 10px}.card.change.insert{border-left:3px solid var(--added)}.card.change.delete{border-left:3px solid var(--removed)}
.card-head{display:flex;align-items:center;gap:8px}
.avatar{width:22px;height:22px;border-radius:50%;flex:none;display:inline-flex;align-items:center;justify-content:center;font-size:10px;font-weight:600;letter-spacing:.02em;background:color-mix(in srgb,var(--fg) 13%,transparent);color:var(--fg)}
.card-main{flex:1;min-width:0;display:flex;flex-direction:column;align-items:flex-start;gap:1px;background:transparent;border:0;padding:0;color:var(--vscode-foreground);text-align:left}
.card-main strong{font-size:12px;font-weight:600;overflow-wrap:anywhere}.card-main .meta{font-size:11px;white-space:nowrap}
.meta{color:var(--dim);font-size:11px}
.chip{display:inline-block;padding:0 5px;border-radius:3px;background:color-mix(in srgb,var(--fg) 9%,transparent);color:var(--dim);font-size:11px;font-variant-numeric:tabular-nums}
.card-text{display:block;width:100%;margin:6px 0 0;padding:0;background:transparent;border:0;color:var(--vscode-foreground);text-align:left;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.45}
body.sidebar .card-text{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden}
.card-reply{display:block;width:100%;margin:6px 0 0;padding:0 0 0 8px;background:transparent;border:0;border-left:2px solid color-mix(in srgb,var(--fg) 45%,transparent);color:var(--vscode-foreground);text-align:left}
.reply-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px}.reply-head strong{font-size:12px;font-weight:600;overflow-wrap:anywhere}
.reply-text{display:block;margin-top:1px;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.45}
body.sidebar .reply-text{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
.card-replies{margin-top:6px}.card-replies>summary{display:flex;flex-wrap:wrap;align-items:center;gap:6px;cursor:pointer;list-style:none}.card-replies>summary::-webkit-details-marker{display:none}
.reply-count::after{content:'';display:inline-block;width:5px;height:5px;margin:0 1px 2px 6px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);transition:transform .12s}.card-replies[open] .reply-count::after{transform:rotate(45deg)}
.card-replies>summary:hover .reply-count{color:var(--vscode-foreground)}
.card:has(>.card-replies[open])>.card-reply{display:none}
body.sidebar .reply-list .reply-text{display:block;-webkit-line-clamp:none;overflow:visible}
.card-quote{margin:6px 0 0;white-space:pre-wrap;color:var(--dim)}
.draft-text{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:4;overflow:hidden}body.panel .draft-text{-webkit-line-clamp:12}.waiting-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.card>.row-reason{margin:6px 0 0}.place-link{border:0;background:transparent;padding:0;font-size:11px;color:var(--vscode-textLink-foreground);cursor:pointer;text-align:left}.place-link:hover:not(:disabled){text-decoration:underline}
.card-quote.gone,.anchor-quote.gone{text-decoration:line-through;color:var(--dim);overflow-wrap:anywhere}
.card-quote.gone{margin:6px 0 2px}
.card-foot{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:6px}
.badge{font-size:10.5px;padding:0 6px;border-radius:8px;border:1px solid var(--line);color:var(--dim);white-space:nowrap}.badge.pending{border-color:var(--accent);color:var(--accent)}.badge.warning{border-color:var(--vscode-editorWarning-foreground);color:var(--vscode-editorWarning-foreground)}
.reply-box{display:flex;gap:6px;align-items:flex-end;margin-top:8px}
.reply-box textarea{flex:1;min-width:0;resize:vertical;min-height:26px;padding:4px 7px;border-radius:4px;border:1px solid var(--vscode-input-border,var(--line));background:var(--vscode-input-background,transparent);color:var(--vscode-input-foreground,var(--vscode-foreground));font-size:12px}
.reply-box textarea::placeholder{color:var(--vscode-input-placeholderForeground,var(--dim))}
.tabs{position:sticky;top:0;z-index:3;display:flex;padding:0 16px;background:var(--vscode-sideBar-background);border-bottom:1px solid var(--line)}.tab{flex:1;display:flex;align-items:center;justify-content:center;gap:5px;min-width:0;margin-bottom:-1px;padding:8px 2px;border:0;border-bottom:2px solid transparent;border-radius:0;background:transparent;color:var(--dim);font:inherit;font-size:12px;cursor:pointer}.tab[aria-selected=true]{border-bottom-color:var(--accent);color:var(--vscode-foreground)}.tab:hover:not([aria-selected=true]){color:var(--vscode-foreground)}.tab:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}.tab-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.tab-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--vscode-editorWarning-foreground)}.tab-pane[hidden]{display:none}
.setup{margin:0;padding:12px 16px}.setup-status{display:flex;align-items:center;gap:7px;color:var(--dim);font-size:12px}.setup-progress{margin-left:auto;font-size:11px}.setup-body{padding-top:12px}.steps{list-style:none;padding:0;margin:0}.steps>li{padding:7px 0}.step-heading{display:flex;align-items:center;gap:8px;font-size:12px}.step-heading strong{font-weight:500}.step-number{width:18px;height:18px;border:1px solid var(--line);border-radius:50%;text-align:center;font-size:11px;color:var(--dim)}.step-heading>.icon{color:var(--added)}.step-content{padding-left:26px;margin-top:5px;font-size:12px;color:var(--dim)}.step-content>.button{margin-top:9px}.setup-help{margin-top:9px;font-size:12px;color:var(--dim)}.setup-help summary{cursor:pointer;color:var(--accent)}.setup-help ol{padding-left:18px}.setup-help li{margin:5px 0}
.marker-style{border-top:1px solid var(--line);padding-top:12px;margin-top:12px}.marker-style .actions{margin:8px 0}
.sync-pane{padding:12px 16px;color:var(--dim);font-size:12px}.freshness{display:flex;align-items:start;gap:6px}.freshness>.icon{margin-top:1px}.poll-controls{display:flex;align-items:center;justify-content:space-between;gap:6px;margin-top:9px}.poll-controls label{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.poll-controls select{color:var(--vscode-dropdown-foreground);background:var(--vscode-dropdown-background);border:1px solid var(--vscode-dropdown-border,var(--line));border-radius:4px;padding:2px 4px;max-width:100%;font-size:12px}.footer-links{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:10px}.version{margin-left:auto;font-variant-numeric:tabular-nums}
.layout{display:grid;grid-template-columns:minmax(300px,400px) minmax(0,1fr);min-height:100vh}.main-col{display:flex;flex-direction:column;border-right:1px solid var(--line);min-width:0;background:var(--vscode-sideBar-background)}
.detail-col{padding:18px 28px;overflow:auto;max-height:100vh;position:sticky;top:0}
.detail-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:space-between;margin-bottom:14px}.detail-head h2{display:flex;align-items:center;gap:8px}
.anchor-quote{margin:0 0 12px;padding:6px 12px;border-left:3px solid var(--accent);background:color-mix(in srgb,var(--accent) 8%,transparent);white-space:pre-wrap;overflow-wrap:anywhere}
.context{margin:0 0 16px;padding:8px 0;border:1px solid var(--line);border-radius:6px;background:var(--vscode-textCodeBlock-background,transparent);font-family:var(--vscode-editor-font-family,monospace);font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}
.context>span{display:block;padding:0 10px}.context>span.anchored{background:color-mix(in srgb,var(--accent) 12%,transparent)}.context .ln{display:inline-block;min-width:3ch;margin-right:12px;color:var(--dim);text-align:right;user-select:none}
.messages{list-style:none;margin:0;padding:0}.messages>li{display:flex;gap:10px;padding:10px 0;border-top:1px solid var(--line)}.messages>li:first-child{border-top:0}.messages p{margin-top:3px;white-space:pre-wrap}.messages .message-body{flex:1;min-width:0}.messages .message-head{display:flex;align-items:center;gap:6px}.messages .message-head .push-right{display:inline-flex;gap:2px}
.empty{margin-top:30vh;text-align:center}.empty p+p{margin-top:6px}
@media(max-width:700px){.layout{grid-template-columns:1fr}.main-col{border-right:0}.detail-col{position:static;max-height:none;border-top:1px solid var(--line)}}
@media(min-width:600px){body.sidebar .project-header,body.sidebar .outgoing-summary,body.sidebar .section,body.sidebar .setup,body.sidebar .sync-pane,body.sidebar .tabs{padding-left:24px;padding-right:24px}body.sidebar .main-actions .button{flex:0 1 auto;padding:7px 13px}}
@media(max-width:240px){.project-header,.outgoing-summary,.section,.setup,.sync-pane,.tabs{padding-left:10px;padding-right:10px}.tab>.icon{display:none}.main-actions{flex-direction:column;align-items:stretch;gap:6px}.main-actions .button{flex:none;font-size:inherit}.file-button{flex-wrap:wrap}.file-name{flex:1 0 calc(100% - 30px)}.counts{margin-left:auto}.card .avatar{display:none}.card-head{gap:6px}.card-main .meta{white-space:normal}.bulk .meta{display:none}.bulk .button.small{flex:1}.review-bar{flex-wrap:wrap;row-gap:6px}.button.ghost{white-space:normal;text-align:left}}
@media(pointer:coarse){button,select,summary{min-height:44px}}
`;
