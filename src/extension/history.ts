import { randomUUID } from 'node:crypto';
import type { CommentChange, SyncHistory } from '../core/projectStore';
import type { Message, Thread } from '../core/models';
import { clip, escapeHtml, initials, shortDateTime } from './format';
import { panelStyle } from './panelStyle';
import { formatSize } from '../core/pictures';

export { escapeHtml };
export function threadText(thread: Thread | undefined): string {
  return thread ? `${thread.resolved ? 'Resolved' : 'Open'}\n\n${thread.messages.map(message => `${message.author}\n${message.text}`).join('\n\n')}` : '(No thread)';
}
type Entry = { message: Message; change?: 'added' | 'edited' | 'removed'; before?: string };
/** The thread after a change, marking what was added, edited or removed. Removed messages keep their place. */
export function messageChanges(before: Thread | undefined, after: Thread | undefined): Entry[] {
  const old = before?.messages ?? [], key = (message: Message, n: number) => message.id ?? `#${n}`;
  const previous = new Map(old.map((message, n) => [key(message, n), message]));
  const entries: Entry[] = (after?.messages ?? []).map((message, n) => {
    const prior = previous.get(key(message, n)); previous.delete(key(message, n));
    return !prior ? { message, change: 'added' } : prior.text !== message.text ? { message, change: 'edited', before: prior.text } : { message };
  });
  for (const message of previous.values()) entries.splice(Math.min(old.indexOf(message), entries.length), 0, { message, change: 'removed' });
  return entries;
}
const changeBadges = { added: ['added', 'New reply'], edited: ['pending', 'Edited'], removed: ['removed', 'Deleted'] } as const;
function messageItem({ message, change, before }: Entry, first: boolean): string {
  const [kind, label] = change ? changeBadges[change] : [];
  return `<li class="message${change ? ' ' + change : ''}"><span class="avatar">${escapeHtml(initials(message.author))}</span><div class="message-body"><div class="message-head"><strong>${escapeHtml(message.author)}</strong><span class="meta">${escapeHtml(shortDateTime(message.timestamp))}</span>${label ? `<span class="badge ${kind}">${change === 'added' && first ? 'New comment' : label}</span>` : ''}</div>${before !== undefined ? `<p class="was">${escapeHtml(before)}</p>` : ''}<p class="text">${escapeHtml(message.text)}</p></div></li>`;
}
/** One card per change: what it is on, then the thread with only the change marked. `actions` adds controls, such as Edit and Discard for a draft. */
export function commentChanges(changes: CommentChange[], actions: (change: CommentChange) => string = () => ''): string {
  return changes.map(change => {
    const head = `<div class="change-head"><strong>${escapeHtml(change.label)}</strong><span class="meta">${escapeHtml(change.path)}</span>${change.line ?? change.suggestion?.line ? `<span class="chip">L${change.line ?? change.suggestion?.line}</span>` : ''}</div>`;
    if (change.suggestion) return `<article class="comment-change" data-change="${escapeHtml(change.id)}">${head}<p class="change-note">${change.suggestion.kind === 'insert' ? 'Added' : 'Deleted'} by ${escapeHtml(change.suggestion.author)}: <span class="${change.suggestion.kind === 'insert' ? 'added' : 'removed strike'}">${escapeHtml(clip(change.suggestion.text, 300))}</span></p>${actions(change)}</article>`;
    const anchor = change.anchorChanged && change.anchorBefore !== undefined
      ? `<blockquote class="anchor-quote"><span class="was">${escapeHtml(clip(change.anchorBefore, 160))}</span> → ${escapeHtml(clip(change.anchorText ?? '', 160))}</blockquote>`
      : change.anchorText ? `<blockquote class="anchor-quote">${escapeHtml(clip(change.anchorText, 160))}</blockquote>` : '';
    const status = change.before && change.after && change.before.resolved !== change.after.resolved
      ? `<p class="status-change"><span class="badge">${change.before.resolved ? 'Resolved' : 'Open'}</span>→<span class="badge pending">${change.after.resolved ? 'Resolved' : 'Open'}</span></p>` : '';
    // Unchanged replies fold into one line; the first message says what the thread is about.
    const entries = messageChanges(change.before, change.after), items: string[] = [];
    for (let n = 0; n < entries.length; n++) {
      let run = n;
      while (n > 0 && run < entries.length && !entries[run].change) run++;
      if (run - n > 1) { items.push(`<li class="more">${run - n} unchanged replies</li>`); n = run - 1; continue; }
      items.push(messageItem(entries[n], n === 0));
    }
    return `<article class="comment-change" data-change="${escapeHtml(change.id)}">${head}${anchor}${status}${items.length ? `<ol class="change-messages">${items.join('')}</ol>` : ''}${actions(change)}</article>`;
  }).join('');
}
export const historyStyle = `.comment-change{border:1px solid var(--line);border-radius:6px;padding:9px 10px;margin:8px 0;background:var(--card)}.change-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.change-head strong{font-size:12px;font-weight:600}.change-note{margin-top:4px;font-size:12px;color:var(--dim)}.comment-change .anchor-quote{margin:8px 0 2px;padding:3px 9px;font-size:12px}.status-change{display:flex;align-items:center;gap:6px;margin-top:6px;font-size:12px;color:var(--dim)}.change-messages{list-style:none;margin:6px 0 0;padding:0}.change-messages>li{display:flex;gap:8px;padding:6px 0;border-top:1px solid var(--line)}.change-messages>li:first-child{border-top:0}.message-body{flex:1;min-width:0}.message-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.message-head strong{font-size:12px;font-weight:600}.change-messages p{margin-top:2px;white-space:pre-wrap;overflow-wrap:anywhere}.message:not(.added):not(.edited):not(.removed) .text{color:var(--dim)}.message.added{box-shadow:inset 2px 0 0 var(--added);padding-left:8px}.message.removed .text{text-decoration:line-through;color:var(--removed)}.was{text-decoration:line-through;color:var(--dim)}.change-messages>li.more{display:block;padding:3px 0 3px 30px;font-size:11px;color:var(--dim)}.badge.added{border-color:var(--added);color:var(--added)}.badge.removed{border-color:var(--removed);color:var(--removed)}body.sidebar .change-messages .text{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:4;overflow:hidden}.history-entry{border-left:2px solid var(--vscode-turnleaf-accent);padding:0 16px;margin:24px 0}.history-entry h2{font-size:16px;margin:8px 0}.history-entry time{color:var(--vscode-descriptionForeground)}.history-entry pre{white-space:pre-wrap;overflow-wrap:anywhere}.outcome{font-size:12px;text-transform:uppercase}.history-files{display:flex;flex-wrap:wrap;gap:8px}`;
const size = (bytes: number) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
// Picture rows of a Get latest record. The overwritten local copy is kept with the record.
const pictureKinds: Record<string, string> = { new: 'new from Overleaf', changed: 'changed on Overleaf', restore: 'restored from Overleaf', deleted: 'deleted on Overleaf, local copy kept', 'both-remote': 'Overleaf version used, your copy kept in Sync history', 'both-local': 'your version kept',
  'send-replace': 'replaced on Overleaf, its copy kept in Sync history', 'send-create': 'new on Overleaf', 'send-restore': 'put back on Overleaf', 'send-delete': 'deleted from Overleaf' };
export function historyPage(entries: SyncHistory[], usage?: { bytes: number; limit: number; days: number }): string {
  const nonce = randomUUID();
  const time = (id: string) => { const record = entries.find(entry => entry.id === id); return record ? new Date(record.time).toLocaleString() : 'an earlier time'; };
  // An undo opens its summary in the sidebar first; what cannot be taken back is listed there.
  const canUndo = (entry: SyncHistory) => entry.direction === 'send' && entry.outcome === 'success' && !entry.undoOf && !entry.undoneBy && entry.files.length + entry.comments.length + (entry.pictures?.length ?? 0) > 0;
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'"><style nonce="${nonce}">${panelStyle}${historyStyle}body{max-width:1000px;margin:0 auto;padding:24px}</style></head><body><h1>Sync history</h1><p class="muted">Local records of file and comment changes. Open a file to compare the before and after copies. Undo this send opens a summary of what is taken back from Overleaf; your local files stay as they are. Operation details include observed read-back results when available. A partial or uncertain result needs reconciliation before another send.</p><div class="actions"><button class="button" data-refresh>Refresh</button>${usage ? `<button class="button" data-clear>Clear older history</button><span class="muted">${entries.length} ${entries.length === 1 ? 'record' : 'records'} · ${size(usage.bytes)} on disk${usage.limit || usage.days ? ` · keeps ${[usage.limit && `the latest ${usage.limit}`, usage.days && `${usage.days} days`].filter(Boolean).join(' and up to ')}` : ''}</span>` : ''}</div>${entries.map(entry => `<article class="history-entry"><time>${escapeHtml(new Date(entry.time).toLocaleString())}</time><h2>${entry.undoOf ? `Undo of the send from ${escapeHtml(time(entry.undoOf))}` : entry.direction === 'send' ? 'Send to Overleaf' : 'Apply locally'} · <span class="outcome">${escapeHtml(entry.outcome)}</span></h2>${entry.undoneBy ? `<p class="muted">Taken back from Overleaf by the undo of ${escapeHtml(time(entry.undoneBy))}.</p>` : ''}<p>${entry.files.length} ${entry.files.length === 1 ? 'file' : 'files'} · ${entry.comments.length} comment ${entry.comments.length === 1 ? 'change' : 'changes'} · ${entry.completed.length} ${entry.completed.length === 1 ? 'step' : 'steps'} verified${entry.check ? ` · ${entry.check.mode === 'fast' ? 'fast check: only reported and written files re-read' : `full check${entry.check.note ? ` (fast send chosen, ${escapeHtml(entry.check.note)})` : ''}`}` : ''}</p>${entry.error ? `<p class="warning">${escapeHtml(entry.error)}</p>` : ''}${entry.warnings.map(warning => `<p class="warning">${escapeHtml(warning)}</p>`).join('')}<div class="history-files">${canUndo(entry) ? `<button class="button primary" data-undo="${escapeHtml(entry.id)}" title="Take this send back from Overleaf. Your local files stay as they are.">Undo this send</button>` : ''}${entry.files.map(file => `<button class="button" data-entry="${escapeHtml(entry.id)}" data-path="${escapeHtml(file.path)}">${escapeHtml(file.path)} · View diff</button>`).join('')}</div>${entry.pictures?.length ? `<ul class="history-pictures">${entry.pictures.map(picture => `<li>${escapeHtml(picture.path)} · ${escapeHtml(pictureKinds[picture.kind] ?? picture.kind)}${picture.before || picture.after ? ` · ${[picture.before, picture.after].map(side => side ? formatSize(side.size) : 'none').join(' → ')}` : ''}</li>`).join('')}</ul>` : ''}${commentChanges(entry.comments)}<details><summary>Operation details</summary><pre>${escapeHtml(JSON.stringify({ id: entry.id, finished: entry.finished, checkpoint: entry.checkpoint, verified: entry.completed, observed: entry.observed }, null, 2))}</pre></details></article>`).join('') || '<p>No sync operations recorded yet.</p>'}<script nonce="${nonce}">const api=acquireVsCodeApi();document.addEventListener('click',event=>{const button=event.target.closest('button');if(button?.hasAttribute('data-refresh'))api.postMessage({refresh:true});else if(button?.hasAttribute('data-clear'))api.postMessage({clear:true});else if(button?.dataset.undo)api.postMessage({undo:button.dataset.undo});else if(button?.dataset.entry)api.postMessage({entry:button.dataset.entry,path:button.dataset.path});});</script></body></html>`;
}
