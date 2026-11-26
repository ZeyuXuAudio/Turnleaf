import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument } from 'htmlparser2';
import { Element, isTag, NodeWithChildren } from 'domhandler';
import { projectContent, projectPanel, ProjectView, OutgoingView, reviewFilterDefault, matchesThreadFilter, matchesSuggestionFilter } from '../src/extension/panel';
import { historyPage } from '../src/extension/history';
import { shortDateTime } from '../src/extension/format';

const view = (extra: Partial<ProjectView> = {}): ProjectView => ({ name: 'Sample project', files: ['main.tex'], state: 'Ready.', writes: true, connected: true, linked: true, rows: [], reviews: {}, ...extra });
function elements(html: string): Element[] {
  const result: Element[] = [];
  const walk = (node: NodeWithChildren) => { for (const child of node.children) { if (isTag(child)) result.push(child); if ('children' in child) walk(child as NodeWithChildren); } };
  walk(parseDocument(html)); return result;
}
const command = (nodes: Element[], id: string) => nodes.find(n => n.attribs['data-command'] === id);
const file = { path: 'main.tex', added: 2, removed: 1 };
const out = (extra: Partial<OutgoingView> = {}): OutgoingView => ({ files: [file], comments: [], ...extra });
const filled = (nodes: Element[]) => nodes.filter(n => /\bmain-actions\b/.test((n.parent as Element)?.attribs?.class ?? '') && /\bprimary\b/.test(n.attribs.class)).map(n => n.attribs['data-command']);
const text = (node: any): string => node.data ?? (node.children ?? []).map(text).join('');

test('comments, incoming messages and tracked edits display local date and time with the author', () => {
  const timestamp = new Date(2026, 10, 5, 14, 37).toISOString();
  assert.match(shortDateTime(timestamp), /14:37/);
  assert.equal(shortDateTime(), ''); assert.equal(shortDateTime('not a date'), '');
  const thread = { id: 't', resolved: false, messages: [{ id: 'm', author: 'Named Reviewer', timestamp, text: 'Please clarify.' }] };
  const row = { path: 'main.tex', line: 3, thread, anchor: { label: 'unchanged', ranges: [] } } as any;
  const html = projectContent(view({ rows: [row], suggestionRows: ['insert', 'delete'].map((kind, n) => ({ id: `s${n}`, kind: kind as 'insert' | 'delete', path: 'main.tex', line: 4, pos: 10, text: 'sample', author: 'Named Reviewer', timestamp })),
    preview: { id: 'p', files: [], comments: [{ id: 't', label: 'New thread', path: 'main.tex', after: thread }] } }));
  const cards = elements(html).filter(node => node.name === 'article');
  assert.equal(cards.length, 4);
  for (const card of cards) {
    const text = (node: any): string => node.data ?? (node.children ?? []).map(text).join('');
    assert.match(text(card), /Named Reviewer/); assert.match(text(card), /14:37/); assert.match(text(card), /NR/);
  }
});

test('a comment whose text is gone explains itself instead of showing a warning at a real line', () => {
  const text = (node: any): string => node.data ?? (node.children ?? []).map(text).join('');
  const thread = { id: 't', resolved: false, messages: [{ id: 'm', author: 'Reviewer', text: 'Please cite this.' }] };
  const row = (label: string, line: number, excerpt: string) => ({ path: 'main.tex', line, excerpt, thread, anchor: { label, ranges: [] } }) as any;
  const card = (r: any) => elements(projectContent(view({ rows: [r] }))).find(node => node.name === 'article')!;
  const part = (node: any, name: string): Element | undefined => {
    for (const child of node.children ?? []) {
      if (isTag(child) && (child.attribs.class ?? '').split(' ').includes(name)) return child;
      const hit = part(child, name); if (hit) return hit;
    }
  };

  const removed = card(row('anchor removed', 15, 'the <old> claim'));
  assert.equal(text(part(removed, 'badge')), 'Text deleted');
  assert(part(removed, 'note') && !part(removed, 'warning'), 'Nothing is wrong, so it is not a warning');
  assert.match(part(removed, 'badge')!.attribs.title, /reply, resolve or delete/);
  assert.equal(text(part(removed, 'chip')), 'near L15');
  assert.equal(text(part(removed, 'gone')), 'the <old> claim');
  assert.doesNotMatch(text(removed), /anchor removed/);

  const unsaved = card(row('anchor removed', 15, ''));
  assert.equal(part(unsaved, 'gone'), undefined, 'A thread with no saved text shows no empty quote');
  assert.match(text(card(row('anchor removed', 15, 'x'.repeat(80)))), /x…/);

  const local = card(row('deleted locally', 4, 'my sentence'));
  assert(part(local, 'warning'), 'A local deletion still warns, because Send would delete the text on Overleaf');
  assert.equal(text(part(local, 'chip')), 'near L4');
  assert.equal(text(part(local, 'gone')), 'my sentence');

  const placed = card(row('unchanged', 3, 'still here'));
  assert.equal(text(part(placed, 'chip')), 'L3');
  assert.equal(part(placed, 'gone'), undefined);

  const large = projectContent(view({ rows: [row('anchor removed', 15, 'the old claim')], selectedThread: 't', detail: { row: row('anchor removed', 15, 'the old claim'), anchorText: '', context: [] } }), 'panel');
  assert.match(large, /<blockquote class="anchor-quote gone">the old claim<\/blockquote>/);
});

test('review, setup and sync are separate views below the main actions', () => {
  const nodes = elements(projectContent(view({ version: '9.9.9', drafts: [{ id: 'd', kind: 'reply', path: 'main.tex', text: 'Draft' }], outgoing: out({ comments: [{ id: 'd', path: 'main.tex', label: 'Reply' }] }), preview: { id: 'p', files: [], comments: [] } })));
  const tabs = nodes.filter(n => n.attribs.role === 'tab'), panes = nodes.filter(n => n.attribs.role === 'tabpanel');
  assert.deepEqual(tabs.map(t => t.attribs['data-tab']), ['review', 'setup', 'sync']);
  assert.deepEqual(panes.map(p => p.attribs['data-pane']), ['review', 'setup', 'sync']);
  assert.deepEqual(tabs.map(t => t.attribs['aria-selected']), ['true', 'false', 'false']);
  assert.deepEqual(panes.map(p => 'hidden' in p.attribs), [false, true, true]);
  // Each control lives in its own view; the main actions stay above all of them.
  const within = (pane: Element, test: (n: any) => boolean) => { const walk = (n: any): boolean => test(n) || (n.children ?? []).some(walk); return walk(pane); };
  const hasCommand = (id: string) => (n: any) => n.attribs?.['data-command'] === id;
  const [review, setup, sync] = panes;
  const summary = nodes.find(n => n.attribs['aria-label'] === 'Outgoing summary')!, header = nodes.find(n => n.name === 'header')!;
  assert(nodes.indexOf(header) < nodes.indexOf(summary) && nodes.indexOf(summary) < nodes.indexOf(tabs[0]), 'The outgoing summary stays in view between the header and the tabs');
  assert(within(summary, hasCommand('editDraft')) && within(summary, hasCommand('openOutgoingDiff')) && !within(review, hasCommand('editDraft')), 'Queued comment changes are listed in the summary only');
  for (const id of ['toggleComments', 'cancelPreview']) assert(within(review, hasCommand(id)), `${id} is in Review`);
  for (const id of ['linkProject', 'configureFiles', 'enableWrites', 'signIn', 'toggleOutlineMarkers']) assert(within(setup, hasCommand(id)), `${id} is in Setup`);
  for (const id of ['showSyncHistory', 'openReviewFiles']) assert(within(sync, hasCommand(id)), `${id} is in Sync`);
  assert(within(sync, (n: any) => n.attribs && 'data-interval' in n.attribs));
  assert(within(sync, (n: any) => n.data?.includes('v9.9.9')) && !within(setup, (n: any) => n.data?.includes('9.9.9')), 'The version appears once, in Sync');
  assert.equal(nodes.find(n => n.attribs.role === 'tablist')!.attribs['data-show-preview'], 'p');
});

test('an unfinished project opens on Setup, and failed checks are flagged on the Sync tab', () => {
  const nodes = elements(projectContent(view({ connected: false, linked: false, files: [] })));
  assert.deepEqual(nodes.filter(n => n.attribs.role === 'tab').map(t => t.attribs['aria-selected']), ['false', 'true', 'false']);
  assert.equal(nodes.find(n => n.attribs.role === 'tablist')!.attribs['data-first-tab'], 'setup');
  const dot = (freshness: string) => elements(projectContent(view({ freshness }))).find(n => n.attribs.class === 'tab-dot');
  assert.equal(dot('Remote state unknown · retry delayed')?.attribs.title, 'Remote state unknown · retry delayed');
  assert.equal(dot('Connection lost · reconnecting')?.attribs.title, 'Connection lost · reconnecting');
  assert.equal(dot('Checked just now'), undefined);
  assert.match(projectPanel(view()), /restoreTab\(\)/);
});
test('the status block shows the kind of state, and only the step it calls for is filled', () => {
  const header = (extra: Partial<ProjectView>) => {
    const nodes = elements(projectContent(view(extra)));
    const status = nodes.find(n => /(^| )status( |$)/.test(n.attribs.class ?? ''))!, state = nodes.find(n => n.attribs.role === 'status' && n.attribs.class === 'state')!;
    const first = nodes.find(n => /\bmain-actions\b/.test((n.parent as Element)?.attribs?.class ?? ''))!;
    return { kind: status.attribs.class.replace('status status-', ''), filled: filled(nodes), above: nodes.indexOf(status) < nodes.indexOf(first), inStatus: state.parent?.parent === status };
  };
  const outgoing = out(), nothing = out({ files: [] });
  const synced = header({ state: 'Up to date with Overleaf.', outgoing: nothing });
  assert.deepEqual([synced.kind, synced.filled], ['synced', []], 'Nothing to do: no filled action');
  assert(synced.inStatus && synced.above, 'The state sits in the status block, above the main actions');
  assert.equal(header({ state: 'Sent and verified on Overleaf.', outgoing: nothing }).kind, 'synced');
  assert.deepEqual(header({ state: 'Not sent yet: 1 file.', outgoing }), { ...synced, kind: 'unsent', filled: ['send'] });
  assert.deepEqual(header({ state: 'Incoming changes available. Get latest to review them.', freshness: 'Incoming updates available', outgoing: nothing }).filled, ['pull']);
  assert.deepEqual(header({ state: 'Overleaf changed too.', freshness: 'Incoming updates available', outgoing: out({ incoming: { files: [file], comments: [] } }) }).filled, ['send'], 'Something goes out: Send stays the step, as Apply & send');
  assert.equal(header({ state: 'Incoming changes available. Get latest to review them.' }).kind, 'incoming');
  assert.deepEqual(header({ preview: { id: 'p', files: [file] }, outgoing }), { ...synced, kind: 'review', filled: ['applyReviewed'] });
  assert.deepEqual(header({ preview: { id: 'p', files: [{ ...file, conflict: true }] } }), { ...synced, kind: 'warning', filled: ['applyReviewed'] });
  assert.deepEqual(header({ preview: { id: 'p', stale: 'main.tex changed on Overleaf.', files: [file] }, outgoing }).filled, ['pull']);
  // A blocked summary names its single way out, and that step is the filled button.
  assert.deepEqual(header({ outgoing: out({ files: [], blocked: { way: 'getLatest', message: 'Overleaf changed the same lines.' } }) }), { ...synced, kind: 'warning', filled: ['pull'] });
  assert.deepEqual(header({ outgoing: out({ files: [], blocked: { way: 'recover', message: 'Recover the interrupted local Apply first.' } }) }).filled, ['recoverLocalApply']);
  assert.deepEqual(header({ outgoing: out({ files: [], blocked: { way: 'draft', message: 'A reply is empty.', draftId: 'd' } }) }).filled, []);
  assert.deepEqual(header({ outgoing: out({ unsaved: ['main.tex'] }) }).filled, ['saveAll']);
  assert.deepEqual(header({ outgoing, writes: false }).filled, ['enableWrites']);
  assert.equal(header({ outgoing: out({ notice: 'Overleaf changed since this summary was shown.' }) }).kind, 'warning');
  const undo = { record: 'h1', time: new Date(2026, 10, 13, 9, 5).toISOString(), files: [file], comments: [], stays: [] };
  assert.deepEqual(header({ undo, outgoing }), { ...synced, kind: 'review', filled: ['sendUndo'] });
  assert.deepEqual(header({ undo: { ...undo, blocked: { way: 'getLatest', message: 'Overleaf changed since your last sync.' } } }).kind, 'warning');
  for (const state of ['Send was interrupted. Get latest to check what reached Overleaf.', 'Cached comments may be stale. Refresh before reviewing remote changes.', 'Local review files: unreadable.']) assert.equal(header({ state }).kind, 'warning', state);
  assert.equal(header({ recovery: true }).kind, 'warning');
  assert.equal(header({ connected: false, state: 'Sign in to refresh or synchronize. Cached comments remain available.' }).kind, 'offline');
  assert.equal(header({ state: 'Project linked. Get latest to review incoming changes.' }).kind, 'info');
  // While a changed file selection is first read: neutral, and still connected.
  assert.equal(header({ state: 'Checking Overleaf…', outgoing: nothing }).kind, 'info');
  const checking = elements(projectContent(view({ state: 'Checking Overleaf…', server: 'https://www.overleaf.com' }))).find(n => n.attribs.class === 'connection')!;
  assert.equal(text(checking), 'Connected · www.overleaf.com');
  // Opening the window, before the stored sign-in is used: connecting, not signed out.
  assert.equal(header({ state: 'Checking Overleaf…', connected: false, checking: true, outgoing: nothing }).kind, 'info');
  assert.equal(text(elements(projectContent(view({ state: 'Checking Overleaf…', connected: false, checking: true, server: 'https://www.overleaf.com' }))).find(n => n.attribs.class === 'connection')!), 'Connecting · www.overleaf.com');
  // The counts moved from the header into the Review view, next to Comment.
  const nodes = elements(projectContent(view({ openComments: 3, suggestions: 2 }))), counts = nodes.find(n => n.attribs.class === 'summary-counts')!;
  assert.equal(counts.parent, command(nodes, 'newComment')!.parent!.parent);
  assert(nodes.indexOf(counts) > nodes.indexOf(nodes.find(n => n.attribs.role === 'tablist')!));
});

test('Send acts on the summary that is shown: one button, by case', () => {
  const page = (extra: Partial<ProjectView>) => { const html = projectContent(view(extra)); return { html, nodes: elements(html) }; };
  const ready = page({ outgoing: out() });
  assert(!('disabled' in command(ready.nodes, 'send')!.attribs)); assert.equal(text(command(ready.nodes, 'send')).trim(), 'Send');
  assert.equal(command(ready.nodes, 'openOutgoingDiff')?.attribs['aria-label'], 'main.tex: 2 added, 1 removed. Open diff: Overleaf now to after send');
  assert.match(ready.html, /<strong>Going out<\/strong> · <span>1 file /); assert(command(ready.nodes, 'reviewDetails'), 'The full report stays in reach');
  assert('disabled' in command(page({ outgoing: out({ busy: true }) }).nodes, 'send')!.attribs, 'Send waits while the summary is recomputed');
  const off = page({ outgoing: out(), writes: false });
  assert(!command(off.nodes, 'send') && filled(off.nodes).includes('enableWrites'));
  const nothing = page({ outgoing: out({ files: [] }) });
  assert(!command(nothing.nodes, 'send') && !command(nothing.nodes, 'reviewDetails')); assert.match(nothing.html, /Nothing to send/);
  const blocked = page({ outgoing: out({ files: [], blocked: { way: 'getLatest', message: 'Overleaf changed the same lines of main.tex.' } }) });
  assert(!command(blocked.nodes, 'send')); assert.doesNotMatch(blocked.html, /Nothing to send/); assert.match(blocked.html, /Overleaf changed the same lines of main\.tex\./);
  const unsaved = page({ outgoing: out({ unsaved: ['main.tex'] }) });
  assert(!command(unsaved.nodes, 'send') && command(unsaved.nodes, 'saveAll')); assert.match(unsaved.html, /Unsaved edits in main\.tex are not included\./);
  const conflict = page({ outgoing: out(), preview: { id: 'p', files: [{ ...file, conflict: true }] } });
  assert('disabled' in command(conflict.nodes, 'applyReviewed')!.attribs && !command(conflict.nodes, 'send'), 'An open Get latest preview is applied or closed first');
  assert.match(page({ outgoing: out({ asOf: '14:37' }) }).html, /Compared with Overleaf as of 14:37/);
  assert.match(page({ outgoing: out({ trackChanges: true }) }).html, /Track Changes is on/);
});
test('the Full/Fast switch in the Send summary: Fast only with the live connection', () => {
  const page = (check: OutgoingView['check'], extra: Partial<OutgoingView> = {}) => { const html = projectContent(view({ outgoing: out({ check, ...extra }) })), nodes = elements(html); return { html, nodes, segment: (value: string) => nodes.find(n => n.attribs['data-command'] === 'setSendCheck' && n.attribs['data-value'] === value)! }; };
  const full = page({ mode: 'full', live: true });
  assert.equal(full.segment('full').attribs['aria-pressed'], 'true'); assert.equal(full.segment('fast').attribs['aria-pressed'], 'false');
  assert(!('disabled' in full.segment('fast').attribs), 'Fast can be chosen while live'); assert.match(full.html, /Re-reads every selected file before and after sending\./);
  const fast = page({ mode: 'fast', live: true });
  assert.equal(fast.segment('fast').attribs['aria-pressed'], 'true'); assert.match(fast.html, /Re-reads only files Overleaf reported as edited, and the files sent\./);
  const offline = page({ mode: 'fast', live: false });
  assert.equal(offline.segment('full').attribs['aria-pressed'], 'true', 'Without a live connection the Send reads in full, and the switch says so');
  assert('disabled' in offline.segment('fast').attribs); assert.equal(offline.segment('fast').attribs.title, 'Fast needs live updates');
  assert.match(offline.html, /Fast needs live updates\. Full check used\./);
  assert(!page({ mode: 'fast', live: true }, { files: [] }).segment('fast'), 'Nothing to send: no switch');
});
test('summary rows: marks for what undo cannot bring back, changed rows, and list toggles', () => {
  const m1 = { id: 'm1', author: 'Reviewer', text: 'Please cite this.' }, thread = { id: 't', resolved: false, messages: [m1] };
  const comments = [{ id: 'r', draftId: 'r', threadId: 't', path: 'main.tex', line: 12, label: 'Reply', before: thread, after: { ...thread, messages: [m1, { id: 'draft:r', author: 'You', text: 'Cited now, see the new reference.' }] } },
    { id: 'x', draftId: 'x', threadId: 't2', path: 'main.tex', line: 30, label: 'Delete thread', before: { ...thread, id: 't2' } }];
  const outgoing = out({ files: [{ ...file, mark: '1 comment loses its text' }, { path: 'refs.bib', added: 1, removed: 0, changed: true }], comments, marks: { x: 'A deleted thread cannot be restored' }, changed: ['r'],
    incoming: { files: [{ path: 'intro.tex', added: 3, removed: 0 }], comments: [] }, notice: 'Overleaf changed since this summary was shown. Nothing was sent: check the marked rows, then send again.' });
  const html = projectContent(view({ outgoing, drafts: [{ id: 'r', kind: 'reply', path: 'main.tex', threadId: 't', text: 'Cited now, see the new reference.' }, { id: 'x', kind: 'deleteThread', path: 'main.tex', threadId: 't2' }] })), nodes = elements(html);
  assert.match(html, /<strong>Going out<\/strong> · <span>2 files [\s\S]*?\+3<\/span>[\s\S]*?−1<\/span>[\s\S]*?<span>2 comment changes<\/span> · <span><span class="cannot-undo">2 cannot be undone<\/span>/);
  assert.match(html, /1 comment loses its text · cannot be undone/); assert.match(html, /A deleted thread cannot be restored · cannot be undone/);
  assert.equal(nodes.filter(n => n.attribs.class === 'row-mark').length, 2); assert.equal(nodes.filter(n => /\brow-changed\b/.test(n.attribs.class ?? '')).length, 2, 'The file and the comment that differ are marked');
  assert.match(html, /Overleaf changed since this summary was shown\./);
  const groups = nodes.filter(n => n.name === 'details' && n.attribs.class === 'summary-group');
  assert.deepEqual(groups.map(g => [g.attribs['data-section'], 'open' in g.attribs]), [['outgoing-list', true], ['incoming-list', true]], 'Each list has its own toggle and is open by default');
  assert(groups[0].attribs['data-force'], 'Rows that need a look open a hidden list again'); assert.equal(groups[1].attribs['data-force'], '');
  assert.match(html, /From Overleaf, applied to your files first<\/strong> · <span>1 file /);
  assert.equal(text(command(nodes, 'send')).trim(), 'Apply & send');
  assert(nodes.some(n => n.attribs['data-command'] === 'openOutgoingDiff' && n.attribs['data-value'] === 'incoming' && n.attribs['data-path'] === 'intro.tex'));
  const row = nodes.find(n => n.name === 'details' && n.attribs['data-section'] === 'row:r')!;
  assert.match(text(row), /Reply\s*main\.tex · L12\s*Cited now, see the new reference\./); assert(!('open' in row.attribs), 'A comment row unfolds on request');
  assert.deepEqual(nodes.filter(n => n.attribs['data-command'] === 'discardDraft').map(n => n.attribs['data-value']), ['r', 'x']);
  assert.match(projectPanel(view()), /data-force/);
  // Without a plan, the queued comment changes stay in reach and the blocking one is marked.
  const waiting = elements(projectContent(view({ drafts: [{ id: 'r', kind: 'reply', path: 'main.tex', threadId: 't', text: '' }], outgoing: out({ files: [], blocked: { way: 'draft', message: 'A reply on main.tex is empty.', draftId: 'r' } }) })));
  assert(waiting.some(n => n.attribs.class === 'card blocking')); assert.equal(command(waiting, 'discardDraft')?.attribs['data-value'], 'r');
});
test('Undo this send: link after a verified send, and a summary of what is taken back and what stays', () => {
  const sent = elements(projectContent(view({ state: 'Sent and verified on Overleaf.', outgoing: out({ files: [] }), undoLatest: 'h1' })));
  assert.equal(command(sent, 'undoSend')?.attribs['data-value'], 'h1'); assert(/\bstatus\b/.test((command(sent, 'undoSend')!.parent as Element).attribs.class));
  assert(!command(elements(projectContent(view({ outgoing: out({ files: [] }) }))), 'undoSend'));
  const time = new Date(2026, 10, 13, 9, 5).toISOString(), thread = { id: 't', resolved: true, messages: [{ id: 'm1', author: 'Reviewer', text: 'Please cite this.' }] };
  const undo = { record: 'h1', time, files: [{ ...file, note: 'Track Changes is on now: the reversal appears on Overleaf as your suggestions.' }], comments: [{ id: 'h1:undo:r', path: 'main.tex', label: 'Reopen thread', before: thread, after: { ...thread, resolved: false } }],
    stays: [{ label: 'Delete thread', path: 'main.tex', reason: 'A recreated message would be a new one written now, not the original.' }] };
  const html = projectContent(view({ undo, outgoing: out(), undoLatest: 'h1' })), nodes = elements(html);
  assert(nodes.some(n => n.attribs['aria-label'] === 'Undo summary') && !nodes.some(n => n.attribs['aria-label'] === 'Outgoing summary'), 'The undo summary takes the place of the outgoing summary');
  assert.match(html, /Undo of the send from [^<]*09:05/); assert.match(html, /<strong>Taken back from Overleaf<\/strong> · <span>1 file [\s\S]*<span>1 comment change<\/span>/);
  assert.match(html, /<strong>Stays as sent<\/strong> · <span>1<\/span>/); assert.match(html, /A recreated message would be a new one written now, not the original\./);
  assert.match(html, /Your local files are not changed; these edits are listed as going out again afterwards\./); assert.match(html, /Track Changes is on now/);
  assert.match(projectContent(view({ undo: { ...undo, files: [{ ...file, mark: '1 comment loses its text' }] } })), /1 comment loses its text · not restored by sending again/);
  assert.equal(command(nodes, 'openOutgoingDiff')?.attribs['data-value'], 'undo');
  assert.deepEqual(filled(nodes), ['sendUndo']); assert(command(nodes, 'cancelUndo') && !command(nodes, 'send') && !command(nodes, 'undoSend') && !command(nodes, 'discardDraft'));
  const blocked = elements(projectContent(view({ undo: { ...undo, files: [], comments: [], stays: [], blocked: { way: 'getLatest', message: 'Overleaf changed since your last sync. Get latest and apply, then undo.' } } })));
  assert('disabled' in command(blocked, 'sendUndo')!.attribs && command(blocked, 'cancelUndo'));
  assert(command(elements(projectContent(view({ undo: { ...undo, unsaved: ['main.tex'] } }))), 'saveAll'));
  // Sync history offers the undo on successful sends only, and names undo records.
  const record = (id: string, extra: object = {}) => ({ id, time, project: 'p', direction: 'send' as const, outcome: 'success' as const, warnings: [], files: [{ path: 'main.tex', before: 'a', after: 'b' }], comments: [], completed: ['file:main.tex'], ...extra });
  const history = historyPage([record('u1', { undoOf: 's1' }), record('s1', { undoneBy: 'u1' }), record('s2'), record('s3', { outcome: 'partial' }), record('l1', { direction: 'pull' })] as any), buttons = elements(history).filter(n => n.attribs['data-undo']);
  assert.deepEqual(buttons.map(n => n.attribs['data-undo']), ['s2'], 'Not for an undo, an undone send, an unfinished send or a local apply');
  assert.match(history, /Undo of the send from /); assert.match(history, /Taken back from Overleaf by the undo of /); assert.match(history, /dataset\.undo/);
});
test('untrusted file names and summary messages cannot inject markup or commands', () => {
  const attack = '"><button data-command="send">send</button><script>alert(1)</script>';
  const nodes = elements(projectContent(view({ name: attack, writes: false, outgoing: out({ files: [{ path: attack, added: 1, removed: 0, mark: attack, note: attack }], comments: [{ id: attack, path: attack, label: attack }], marks: { [attack]: attack }, notice: attack, blocked: { way: 'fix', message: attack }, unsaved: [attack], asOf: attack }),
    preview: { id: attack, stale: attack, files: [{ path: attack, added: 1, removed: 0 }] } })));
  assert(!nodes.some(n => n.name === 'script'));
  assert(!command(nodes, 'send'));
  assert.equal(command(nodes, 'openOutgoingDiff')?.attribs['data-path'], attack);
  assert.equal(command(nodes, 'openPreviewDiff')?.attribs['data-path'], attack);
  assert.equal(command(nodes, 'openPreviewDiff')?.attribs['data-preview'], attack);
  const undo = elements(projectContent(view({ undo: { record: attack, time: attack, files: [{ path: attack, added: 1, removed: 0 }], comments: [], stays: [{ label: attack, path: attack, reason: attack }], notice: attack }, undoLatest: attack })));
  assert(!undo.some(n => n.name === 'script') && !command(undo, 'send'));
});

test('comment-only summaries enable Send and expose exact before/after content and local drafts', () => {
  const before = { id: 'c1', resolved: false, messages: [{ id: 'm1', author: 'Author', text: 'Original message' }] };
  const after = { ...before, messages: [{ ...before.messages[0], text: 'Revised message' }] };
  const html = projectContent(view({ outgoing: out({ files: [], comments: [{ id: 'draft', path: 'main.tex', label: 'Edit message', before, after }] }), drafts: [{ id: 'draft', kind: 'editMessage', path: 'main.tex', text: 'Revised message' }] }));
  const nodes = elements(html);
  assert(!('disabled' in command(nodes, 'send')!.attribs));
  assert(html.includes('Original message')); assert(html.includes('Revised message'));
  assert(command(nodes, 'editDraft')); assert(command(nodes, 'discardDraft')); assert(command(nodes, 'showSyncHistory'));
});

test('history and comment comparisons escape untrusted source, authors, messages and errors', () => {
  const attack = '<script data-evil="true">bad()</script><button data-entry="evil">bad</button>';
  const thread = { id: 'c', resolved: false, messages: [{ author: attack, text: attack }] };
  const html = historyPage([{ id: 'history', time: new Date().toISOString(), project: 'p', direction: 'send', outcome: 'uncertain', error: attack, warnings: [attack], files: [{ path: attack, before: attack, after: attack }], comments: [{ id: 'c', path: attack, label: attack, before: thread, after: thread }], completed: [] }]);
  const nodes = elements(html);
  assert(!nodes.some(node => node.attribs['data-evil'] || node.attribs['data-entry'] === 'evil'));
  assert.equal(nodes.filter(node => node.name === 'script').length, 1, 'Only the nonce-protected trusted handler is executable');
});

test('new comment drafts can update their selection without discarding dependent work', () => {
  const draft = { id: 'draft-anchor', kind: 'createThread', path: 'main.tex', text: 'Pending comment' };
  const outgoing = out({ files: [], comments: [{ id: draft.id, path: 'main.tex', label: 'New thread' }] });
  assert(!command(elements(projectContent(view({ drafts: [draft], outgoing }))), 'reattachDraft'), 'A comment that follows its text needs no new selection');
  const html = projectContent(view({ drafts: [{ ...draft, unplaced: true }], outgoing })), nodes = elements(html);
  assert.equal(command(nodes, 'reattachDraft')?.attribs['data-value'], draft.id);
  assert.match(html, /Needs a new selection/); assert.match(html, /Select the text again in the editor, then click Update selection/);
  assert(!command(elements(projectContent(view({ drafts: [{ ...draft, unplaced: true, uncertain: true }], outgoing }))), 'reattachDraft'), 'An uncertain remote outcome must be reconciled first');
  const placed = elements(projectContent(view({ drafts: [draft], outgoing: { ...outgoing, places: { [draft.id]: { command: 'openThread', value: 'thread-1' } } } })));
  assert.equal(command(placed, 'openThread')?.attribs['data-value'], 'thread-1', 'Show in editor goes to the thread');
  const suggestion = elements(projectContent(view({ outgoing: out({ files: [], comments: [{ id: 'd', path: 'main.tex', label: 'Accept suggestion' }], places: { d: { command: 'openSuggestion', path: 'main.tex', value: '42' } } }) })));
  assert.equal(command(suggestion, 'openSuggestion')?.attribs['data-path'], 'main.tex'); assert.equal(command(suggestion, 'openSuggestion')?.attribs['data-value'], '42');
  const comments = elements(projectContent(view({ preview: { id: 'r', files: [], comments: [{ id: 'thread-id', path: 'main.tex', label: 'Updated thread' }] } })));
  assert(comments.some(node => node.name === 'article' && node.attribs['data-change'] === 'thread-id'), 'Each comment change is one card');
});

test('each control appears once per surface and reply counts read naturally', () => {
  const thread = (replies: number) => ({ id: `t${replies}`, resolved: false, messages: Array.from({ length: replies + 1 }, (_, n) => ({ id: `m${n}`, author: 'Author', text: 'Message' })) });
  const rows = [1, 2].map(replies => ({ path: 'main.tex', docId: 'd', line: replies, excerpt: '', thread: thread(replies), anchor: { label: 'unchanged', ranges: [] } })) as any;
  const sidebar = projectContent(view({ rows, activePath: 'main.tex' }));
  assert.match(sidebar, />1 reply</); assert.match(sidebar, />2 replies</);
  const nodes = elements(sidebar), count = (id: string) => nodes.filter(n => n.attribs['data-command'] === id).length;
  assert.equal(count('openOverleaf'), 1, 'Open on Overleaf stays in the header only');
  assert.equal(count('showReviewPanel'), 0, 'The sidebar title bar offers the larger view');
  assert.equal(count('checkRemote'), 0, 'The sidebar title bar offers the remote check');
  assert.equal(elements(projectContent(view(), 'panel')).filter(n => n.attribs['data-command'] === 'checkRemote').length, 1, 'The larger view has no title bar, so its footer keeps the check');
});

test('a comment card shows its newest reply and unfolds every reply from the reply count', () => {
  const row = (id: string, messages: { id: string; author: string; text: string }[]) => ({ path: 'main.tex', docId: 'd', line: 1, excerpt: '', thread: { id, resolved: false, messages }, anchor: { label: 'unchanged', ranges: [] } });
  const rows = [row('t1', [{ id: 'm0', author: 'Ada', text: 'Cite this.' }, { id: 'm1', author: 'Bo', text: 'Older reply' }, { id: 'm2', author: 'Cy', text: 'Newest reply' }]),
    row('t2', [{ id: 'm3', author: 'Ada', text: 'Alone' }]), row('t3', [{ id: 'm4', author: 'Ada', text: 'Typo?' }, { id: 'draft:r', author: 'You', text: 'Fixed' }])] as any;
  const html = projectContent(view({ rows, activePath: 'main.tex' })), nodes = elements(html);
  // Outside the folded list: the newest reply only.
  const preview = nodes.filter(n => n.attribs.class === 'card-reply' && (n.parent as any)?.name === 'article');
  assert.deepEqual(preview.map(n => n.attribs['data-id']), ['t1', 't3'], 'Only threads with replies show one');
  assert.match(html, /<\/button>\s*<button type="button" class="card-reply"[^>]*><span class="reply-head"><strong>Cy<\/strong>[\s\S]*?Newest reply/);
  assert.match(html, /<strong>You<\/strong>[^]*?Pending send<\/span><\/span><span class="reply-text">Fixed/);
  // The reply count unfolds all replies in order; the folded state is remembered per thread.
  const folds = nodes.filter(n => n.name === 'details' && n.attribs.class === 'card-replies');
  assert.deepEqual(folds.map(n => n.attribs['data-section']), ['replies:t1', 'replies:t3']);
  assert(folds.every(n => n.attribs.open === undefined), 'Replies start folded');
  assert.match(html, /data-section="replies:t1"><summary><span class="meta reply-count">2 replies<\/span><\/summary><div class="reply-list">[\s\S]*?Older reply[\s\S]*?Newest reply[\s\S]*?<\/div><\/details>/);
  assert(!nodes.some(n => n.attribs['data-section'] === 'replies:t2'), 'A comment without replies has nothing to unfold');
});

test('each comment card has a Show more toggle for its first message, shown only once the text is cut', () => {
  const rows = ['t1', 't2'].map((id, line) => ({ path: 'main.tex', docId: 'd', line: line + 1, excerpt: '', thread: { id, resolved: false, messages: [{ id: `${id}m`, author: 'Ada', text: 'A long comment.' }] }, anchor: { label: 'unchanged', ranges: [] } })) as any;
  const html = projectContent(view({ rows, activePath: 'main.tex' })), nodes = elements(html);
  const toggles = nodes.filter(n => n.attribs.class === 'text-toggle');
  assert.deepEqual(toggles.map(n => n.attribs['data-text-toggle']), ['t1', 't2']);
  assert(toggles.every(n => n.attribs.hidden !== undefined && n.attribs['aria-expanded'] === 'false' && text(n) === 'Show more'), 'Hidden until the page measures the text as cut');
  assert.match(html, /class="card-text"[^>]*>A long comment\.<\/button>\s*<button type="button" class="text-toggle"/, 'Directly under the first message');
  // The page measures the cut text, keeps the choice per thread and ties it to unfolding the replies.
  const page = projectPanel(view({ rows, activePath: 'main.tex' }));
  for (const part of ['function fitTexts()', "remembered['text:'+id]=full", "closest('.card-replies>summary')", 'document.fonts?.ready.then(fitTexts)']) assert(page.includes(part), part);
});

test('sign-in, live updates, first-sync choices and combined sends render their controls', () => {
  const signedOut = elements(projectContent(view({ connected: false, linked: false, files: [] })));
  assert.match(command(signedOut, 'signIn')!.children.map((c: any) => c.data ?? c.children?.[0]?.data).join(''), /Sign in with browser/);
  assert(command(signedOut, 'signInWithCookie'), 'Cookie paste stays available as a fallback');
  assert(!projectContent(view()).includes('Where do I find the cookie?'), 'No cookie help once signed in');
  const live = elements(projectContent(view({ interval: 'live' }))).find(n => n.name === 'option' && 'selected' in n.attribs);
  assert.equal(live?.attribs.value, 'live');
  const first = elements(projectContent(view({ preview: { id: 'p', files: [{ path: 'main.tex', added: 1, removed: 1, conflict: true, firstSync: true }] } })));
  assert(command(first, 'useRemoteVersion') && command(first, 'keepLocalVersion') && command(first, 'resolveConflict'));
  assert('disabled' in command(first, 'applyReviewed')!.attribs && !command(first, 'send'));
  // A kept local version is applied like any other choice; it is then listed as going out.
  const kept = elements(projectContent(view({ preview: { id: 'p', files: [{ path: 'main.tex', added: 0, removed: 0, firstSync: true, kept: true, note: 'Your version kept. It is then listed as going out to Overleaf.' }, { path: 'refs.bib', added: 0, removed: 0, firstSync: true, kept: true }] } })));
  assert.equal(command(kept, 'applyReviewed')?.attribs['data-preview'], 'p'); assert.equal(text(command(kept, 'applyReviewed')).trim(), 'Apply (2)');
  assert(!('disabled' in command(kept, 'applyReviewed')!.attribs) && !command(kept, 'applyAndReview'));
  const partly = elements(projectContent(view({ preview: { id: 'p', files: [{ path: 'main.tex', added: 0, removed: 0, firstSync: true, kept: true }, { path: 'refs.bib', added: 1, removed: 1, conflict: true, firstSync: true }] } })));
  assert('disabled' in command(partly, 'applyReviewed')!.attribs);
});

test('review cards: Overleaf-style buttons, exception badges, suggestions and the larger view detail', () => {
  const thread = { id: 't1', resolved: false, messages: [{ id: 'm1', author: 'Alex Morgan', text: 'How was rain detected?', timestamp: '2026-10-17T16:17:00Z' }, { id: 'm2', author: 'Reviewer', text: 'Agreed.' }] };
  const row = { path: 'main.tex', docId: 'd', line: 35, excerpt: '', thread, anchor: { label: 'unchanged', ranges: [] } } as any;
  const suggestion = { id: 's1', path: 'main.tex', line: 44, pos: 120, kind: 'delete' as const, text: 'of all three sensors ', author: 'alex.morgan' };
  const html = projectContent(view({ rows: [row], suggestionRows: [suggestion], activePath: 'main.tex', selectedThread: 't1', drafts: [{ id: 'd1', kind: 'reply', path: 'main.tex', threadId: 't1', text: 'Pending' }] }));
  const nodes = elements(html);
  assert.equal(command(nodes, 'resolve')?.attribs['data-value'], 't1');
  assert.equal(command(nodes, 'reply')?.attribs['data-value'], 't1');
  assert(nodes.some(n => n.name === 'textarea' && n.attribs['data-reply'] === 't1'), 'Inline reply box');
  assert.match(html, />AM</); assert.match(html, /Pending send/); assert(!/class="badge[^"]*"[^>]*>Open</.test(html), 'No badge for an open, unchanged thread');
  assert.equal(command(nodes, 'openSuggestion')?.attribs['data-value'], '120');
  assert(html.indexOf('How was rain') < html.indexOf('of all three'), 'Cards follow source order');
  assert.equal(command(nodes, 'acceptChange')?.attribs['data-value'], 's1'); assert.equal(command(nodes, 'rejectChange')?.attribs['aria-pressed'], 'false');
  // A pending decision presses its button, which then undoes it, and shows in the pending list.
  const decided = elements(projectContent(view({ suggestionRows: [{ ...suggestion, decision: 'reject' }], activePath: 'main.tex', drafts: [{ id: 'd2', kind: 'rejectChange', path: 'main.tex', suggestion: { kind: 'delete', text: 'of all three sensors ' } }] })));
  assert.equal(command(decided, 'rejectChange')?.attribs['aria-pressed'], 'true'); assert.equal(command(decided, 'rejectChange')?.attribs.title, 'Undo reject');
  assert.match(projectContent(view({ suggestionRows: [{ ...suggestion, decision: 'reject' }], activePath: 'main.tex', drafts: [{ id: 'd2', kind: 'rejectChange', path: 'main.tex', suggestion: { kind: 'delete', text: 'of all three sensors ' } }] })), /Reject on send<\/span>/);
  const preview = projectContent(view({ drafts: [{ id: 'd2', kind: 'rejectChange', path: 'main.tex', suggestion: { kind: 'delete', text: 'x' } }], outgoing: out({ comments: [{ id: 'd2', draftId: 'd2', path: 'main.tex', label: 'Reject suggestion', suggestion: { decision: 'reject', kind: 'delete', text: 'of all three', author: 'R', line: 44 } }] }) }));
  assert.match(preview, /<span>1 file [\s\S]*<span>1 comment change<\/span>[\s\S]*Reject suggestion<\/span><span class="meta">main\.tex · L44<\/span>[\s\S]*Deleted by R/);
  assert.equal(command(elements(preview), 'discardDraft')?.attribs['data-value'], 'd2');
  assert.match(projectContent(view({ version: '9.9.9' })), /v9\.9\.9/);
  const panel = projectContent(view({ rows: [row], detail: { row, anchorText: 'Readings during rain were removed', context: [{ line: 35, text: 'Readings during rain were removed.', anchored: true }] } }), 'panel');
  assert.match(panel, /class="layout"/); assert.match(panel, /Readings during rain were removed/); assert.match(panel, /Agreed\./);
  assert(!elements(projectContent(view({ rows: [row] }), 'panel')).some(n => n.attribs['data-reply'] === 't1' && n.attribs.rows === '1'), 'The larger view replies in the detail column');
});

test('comment change cards say what the comment is on and mark only the change', () => {
  const m1 = { id: 'm1', author: 'alex.morgan', authorId: 'u1', text: 'Which earlier field studies use 0.50 units?', timestamp: '2026-10-17T10:00:00Z' };
  const before = { id: 't', resolved: false, messages: [m1] };
  const reply = { id: 'r', draftId: 'r', threadId: 't', path: 'main.tex', line: 39, label: 'Reply', anchorText: 'the tolerance of 0.50 units', before, after: { ...before, messages: [m1, { id: 'draft:r', author: 'You', text: 'maybe a test' }] } };
  const html = projectContent(view({ drafts: [{ id: 'r', kind: 'reply', path: 'main.tex', threadId: 't', text: 'maybe a test' }], outgoing: out({ comments: [reply] }) }));
  assert.match(html, /<strong>Reply<\/strong><span class="meta">main\.tex<\/span><span class="chip">L39<\/span>/);
  assert.match(html, /class="anchor-quote">the tolerance of 0\.50 units</);
  assert.match(html, /<li class="message"><span class="avatar">AM<\/span>[\s\S]*0\.50 units\?<\/p><\/div><\/li><li class="message added">[\s\S]*<strong>You<\/strong>[\s\S]*New reply<\/span>[\s\S]*maybe a test/);
  const pulled = projectContent(view({ preview: { id: 'p', files: [file], comments: [reply] } }));
  assert.match(pulled, /File text \(1\)<\/h3><p class="muted">The diff shows file text only\./); assert.match(pulled, />Comments \(1\)</);
  assert(!/BEFORE|Before<\/h3>|threadText/i.test(html.replace(/before/g, '')), 'No before and after columns');
  const edited = projectContent(view({ outgoing: out({ files: [], comments: [{ id: 'e', path: 'main.tex', label: 'Edit message', before, after: { ...before, messages: [{ ...m1, text: 'Which studies?' }] } }] }) }));
  assert.match(edited, /Edited<\/span><\/div><p class="was">Which earlier field studies use 0\.50 units\?<\/p><p class="text">Which studies\?<\/p>/);
  const resolved = projectContent(view({ outgoing: out({ files: [], comments: [{ id: 's', path: 'main.tex', label: 'Resolve thread', before, after: { ...before, resolved: true } }] }) }));
  assert.match(resolved, /<span class="badge">Open<\/span>→<span class="badge pending">Resolved<\/span>/);
  const long = { ...before, messages: [m1, ...[2, 3, 4].map(n => ({ id: `m${n}`, author: 'R', text: `Reply ${n}` }))] };
  const folded = projectContent(view({ preview: { id: 'p', files: [], comments: [{ id: 'l', path: 'main.tex', label: 'Updated thread', before: long, after: { ...long, messages: [...long.messages, { id: 'm5', author: 'R', text: 'Newest' }] } }] } }));
  assert.match(folded, /3 unchanged replies<\/li><li class="message added">[\s\S]*Newest/);
  const removed = projectContent(view({ outgoing: out({ files: [], comments: [{ id: 'd', path: 'main.tex', label: 'Delete thread', before }] }) }));
  assert.match(removed, /<li class="message removed">[\s\S]*Deleted<\/span>/);
});

test('highlight switch, Accept all / Reject all per file, and editing your own comments', () => {
  const on = elements(projectContent(view({ highlightComments: true })));
  assert.equal(command(on, 'toggleHighlights')?.attribs.role, 'switch'); assert.equal(command(on, 'toggleHighlights')?.attribs['aria-checked'], 'true');
  assert.match(command(on, 'toggleHighlights')?.attribs.title ?? '', /Selected review items/);
  assert.equal(command(elements(projectContent(view({ highlightComments: false }))), 'toggleHighlights')?.attribs['aria-checked'], 'false');
  const s = (id: string, line: number, decision?: 'accept' | 'reject') => ({ id, path: 'main.tex', line, pos: line, kind: 'insert' as const, text: 'x', author: 'R', ...decision && { decision } });
  const two = elements(projectContent(view({ activePath: 'main.tex', suggestionRows: [s('a', 1), s('b', 2)] })));
  assert.equal(command(two, 'acceptAllChanges')?.attribs['data-path'], 'main.tex'); assert(command(two, 'rejectAllChanges'));
  assert.match(projectContent(view({ activePath: 'main.tex', suggestionRows: [s('a', 1, 'accept'), s('b', 2, 'accept')] })), /Undo accept all/);
  assert(!command(elements(projectContent(view({ activePath: 'main.tex', suggestionRows: [s('a', 1)] }))), 'acceptAllChanges'), 'One suggestion needs no bulk action');
  assert(!command(two, 'decideAuthorChanges'), 'One author needs no choice of author');
  const twoAuthors = elements(projectContent(view({ activePath: 'main.tex', suggestionRows: [s('a', 1), { ...s('b', 2), author: 'Other' }] })));
  assert.equal(command(twoAuthors, 'decideAuthorChanges')?.attribs['data-path'], 'main.tex');
  const sameName = elements(projectContent(view({ activePath: 'main.tex', suggestionRows: [{ ...s('a', 1), authorId: 'u1' }, { ...s('b', 2), authorId: 'u2' }] })));
  assert(command(sameName, 'decideAuthorChanges'), 'Two accounts with one name are two authors');
  const thread = { id: 't1', resolved: false, messages: [{ id: 'm1', author: 'Me', authorId: 'u1', text: 'Mine' }, { id: 'm2', author: 'R', authorId: 'u2', text: 'Theirs' }, { id: 'draft:x', author: 'You', authorId: 'u1', text: 'Pending' }] };
  const row = { path: 'main.tex', docId: 'd', line: 3, excerpt: '', thread, anchor: { label: 'unchanged', ranges: [] } } as any;
  const card = elements(projectContent(view({ rows: [row], activePath: 'main.tex', selectedThread: 't1', userId: 'u1' })));
  assert.equal(command(card, 'editMessage')?.attribs['data-message'], 'm1'); assert.equal(command(card, 'deleteMessage')?.attribs['data-value'], 't1');
  assert(!command(elements(projectContent(view({ rows: [row], activePath: 'main.tex', selectedThread: 't1', userId: 'u2' }))), 'editMessage'), 'Only your own messages');
  const larger = elements(projectContent(view({ rows: [row], userId: 'u1', detail: { row, anchorText: '', context: [] } }), 'panel'));
  assert.deepEqual(larger.filter(n => n.attribs['data-command'] === 'editMessage').map(n => n.attribs['data-message']), ['m1'], 'Sent messages only; pending drafts are edited in the pending list');
});

test('review filter chips list open, resolved, suggestions and going-out items, each with its count', () => {
  const thread = (id: string, resolved: boolean) => ({ path: 'main.tex', docId: 'd', line: 1, excerpt: '', thread: { id, resolved, messages: [{ id: `m-${id}`, author: 'A', text: `Thread ${id}` }] }, anchor: { label: 'unchanged', ranges: [] } }) as any;
  const rows = [thread('open1', false), thread('done1', true), thread('done2', true)];
  const suggestionRows = [{ id: 's1', path: 'main.tex', line: 2, pos: 5, kind: 'insert' as const, text: 'Suggested words', author: 'B' }];
  const base = { rows, suggestionRows, activePath: 'main.tex', drafts: [{ id: 'r', kind: 'resolve', path: 'main.tex', threadId: 'done2' }] };
  const html = projectContent(view(base)), nodes = elements(html);
  const chip = (kind: string) => nodes.find(n => n.attribs['data-command'] === 'toggleReviewFilter' && n.attribs['data-value'] === kind)!;
  assert.deepEqual(['open', 'resolved', 'suggestions', 'outgoing'].map(kind => [chip(kind).attribs['aria-pressed'], text(chip(kind))]), [['true', 'Open1'], ['false', 'Resolved2'], ['true', 'Suggestions1'], ['true', 'Going out1']]);
  assert.match(html, /Thread open1/); assert.match(html, /Suggested words/);
  assert.match(html, /Thread done2/, 'A resolved thread with a draft going out shows while Going out is on');
  assert.doesNotMatch(html, /Thread done1/, 'Resolved threads are hidden by default');
  const resolvedOnly = projectContent(view({ ...base, reviewFilter: { open: false, resolved: true, suggestions: false, outgoing: false } }));
  assert.match(resolvedOnly, /Thread done1/); assert.doesNotMatch(resolvedOnly, /Thread open1|Suggested words/);
  assert.match(projectContent(view({ ...base, reviewFilter: { open: false, resolved: false, suggestions: false, outgoing: false } })), /Nothing matches the chosen kinds/);
  assert.equal(matchesThreadFilter(false, false, reviewFilterDefault), true);
  assert.equal(matchesThreadFilter(true, false, reviewFilterDefault), false, 'Resolved threads are excluded by default');
  assert.equal(matchesThreadFilter(true, true, reviewFilterDefault), true, 'Resolved threads with outgoing drafts match Going out');
  assert.equal(matchesThreadFilter(false, false, { open: false, resolved: true, suggestions: false, outgoing: false }), false);
  assert.equal(matchesSuggestionFilter(false, reviewFilterDefault), true);
  assert.equal(matchesSuggestionFilter(false, { open: true, resolved: false, suggestions: false, outgoing: true }), false, 'Undecided suggestions hide when Suggestions is off');
  assert.equal(matchesSuggestionFilter(true, { open: true, resolved: false, suggestions: false, outgoing: true }), true, 'Decided suggestions match Going out');
  assert.equal(matchesSuggestionFilter(true, { open: true, resolved: false, suggestions: false, outgoing: false }), false);
});

test('the Setup tab has a switch for comment files for AI agents and scripts', () => {
  const on = elements(projectContent(view({ reviewFiles: true })));
  const toggle = on.find(n => n.attribs['data-command'] === 'toggleReviewFiles')!;
  assert.equal(toggle.attribs['aria-checked'], 'true'); assert(command(on, 'openReviewFiles'));
  assert.equal(elements(projectContent(view({ reviewFiles: false }))).find(n => n.attribs['data-command'] === 'toggleReviewFiles')!.attribs['aria-checked'], 'false');
});

test('Comment appearance offers markers below the paragraph or on the commented line', () => {
  const pressed = (value: ProjectView) => elements(projectContent(value)).filter(n => n.attribs['data-command'] === 'setCommentMarkers').map(n => [n.attribs['data-value'], n.attribs['aria-pressed']]);
  assert.deepEqual(pressed(view({})), [['belowParagraph', 'true'], ['commentedLine', 'false']]);
  assert.deepEqual(pressed(view({ commentMarkers: 'commentedLine' })), [['belowParagraph', 'false'], ['commentedLine', 'true']]);
  assert.match(projectContent(view({})), /hover it to open the thread/);
});

test('waiting comment changes put the blocking one first, link to their place and fold long text', () => {
  const drafts = [{ id: 'fine', kind: 'reply', path: 'main.tex', threadId: 't1', text: 'A reply', line: 4, place: { command: 'openThread' as const, value: 't1' } },
    { id: 'stuck', kind: 'createThread', path: 'main.tex', threadId: 't2', text: 'Long comment\n'.repeat(20), line: 9, unplaced: true, place: { command: 'openThread' as const, value: 't2' } }];
  const html = projectContent(view({ drafts, outgoing: out({ files: [], comments: [], blocked: { way: 'draft', message: 'Blocked', draftId: 'stuck' } }) })), nodes = elements(html);
  assert(html.indexOf('Blocks Send') < html.indexOf('A reply'), 'The blocking comment comes first');
  const links = nodes.filter(n => n.attribs.class === 'place-link');
  assert.deepEqual(links.map(n => [n.attribs['data-command'], n.attribs['data-value'], text(n)]), [['openThread', 't2', 'main.tex · L9'], ['openThread', 't1', 'main.tex · L4']]);
  assert(nodes.some(n => n.name === 'p' && /draft-text/.test(n.attribs.class ?? '')), 'Long text folds');
  assert.equal(command(nodes, 'reattachDraft')?.attribs['data-value'], 'stuck');
  const row = elements(projectContent(view({ drafts: [drafts[0]], outgoing: out({ files: [], comments: [{ id: 'fine', draftId: 'fine', threadId: 't1', path: 'main.tex', line: 4, label: 'Reply' }], places: { fine: { command: 'openThread', value: 't1' } } }) })));
  const link = row.find(n => n.attribs.class === 'place-link')!;
  assert.equal((link.parent as any)?.name, 'summary', 'The row head links to its place'); assert.equal(link.attribs['data-value'], 't1');
});
