import test from 'node:test';
import assert from 'node:assert/strict';
import { projectPanel, ProjectView } from '../src/extension/panel';

// The project view's own script, run against stub DOM objects: what it reports for each kind of press.
// A click event fires only on an enabled button; `detail` is the browser's click count.
type Button = { dataset: Record<string, string>; disabled: boolean; isConnected: boolean; getAttribute(): null; closest(selector: string): Button | null };
function load() {
  const view: ProjectView = { name: 'Sample project', files: ['main.tex'], state: 'Ready.', writes: true, connected: true, linked: true, rows: [], reviews: {} };
  const html = projectPanel(view, 'panel');
  const script = html.slice(html.indexOf('<script nonce="'), html.lastIndexOf('</script>')).replace(/^<script nonce="[^"]+">/, '');
  const posted: any[] = [], rendered: string[] = [], listeners: Record<string, ((event: any) => void)[]> = {}, windowListeners: Record<string, ((event: any) => void)[]> = {};
  const project = { set innerHTML(value: string) { rendered.push(value); }, get innerHTML() { return ''; } };
  const document = {
    addEventListener: (type: string, fn: (event: any) => void) => { (listeners[type] ??= []).push(fn); },
    querySelectorAll: () => [], querySelector: () => null, getElementById: (id: string) => id === 'project' ? project : null,
    body: { classList: { contains: () => false } }, hasFocus: () => false, activeElement: null,
  };
  const window = { addEventListener: (type: string, fn: (event: any) => void) => { (windowListeners[type] ??= []).push(fn); }, scrollY: 0, scrollTo() {} };
  const api = { getState: () => ({}), setState() {}, postMessage: (message: unknown) => posted.push(message) };
  new Function('acquireVsCodeApi', 'document', 'window', 'CSS', script)(() => api, document, window, { escape: (value: string) => value });
  assert.deepEqual(posted.slice(), [{ ready: true }], 'The view asks for its first render'); posted.length = 0;
  const fire = (type: string, event: unknown) => (listeners[type] ?? []).forEach(fn => fn(event));
  const target = (b: Button) => ({ closest: (selector: string) => selector === 'button' ? b : null, matches: () => false });
  const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
  return {
    posted, rendered, tick,
    button(command: string, disabled = false, data: Record<string, string> = {}): Button { const b: Button = { dataset: { command, ...data }, disabled, isConnected: true, getAttribute: () => null, closest: selector => selector === 'button' ? b : null }; return b; },
    down: (b: Button) => fire('pointerdown', { button: 0, target: target(b) }),
    up: () => fire('pointerup', {}),
    clickEvent: (b: Button, detail: number) => fire('click', { target: target(b), detail, preventDefault() {} }),
    async click(b: Button, detail: number) { this.down(b); await tick(); this.up(); if (!b.disabled) this.clickEvent(b, detail); await tick(); },
    render: (html: string) => (windowListeners.message ?? []).forEach(fn => fn({ data: { type: 'render', html } })),
    kinds: () => posted.map(m => m.type === 'press' ? `press ${m.detail} ${m.disabled ? 'disabled' : 'enabled'}` : m.type ?? `command ${m.command}`),
  };
}

test('view presses: a double click, one onto the button turned disabled, a retry once enabled, two different message buttons', async () => {
  const v = load();
  let b = v.button('send');
  await v.click(b, 1); await v.click(b, 2);
  assert.deepEqual(v.kinds(), ['press 1 enabled', 'release', 'command send', 'press 2 enabled', 'release', 'click-extra'], 'A double click sends once');
  await v.tick(550); v.posted.length = 0;
  b = v.button('send'); await v.click(b, 1); b.disabled = true; await v.click(b, 2);
  assert.deepEqual(v.kinds(), ['press 1 enabled', 'release', 'command send', 'press 2 disabled', 'release'], 'The second click of a double click on Sending… stays an extra press');
  await v.tick(550); v.posted.length = 0;
  b = v.button('send', true); await v.click(b, 1); b.disabled = false; await v.click(b, 2);
  assert.deepEqual(v.kinds(), ['press 1 disabled', 'release', 'press 1 enabled', 'release', 'command send'], 'A press once Send is enabled again sends, even right after one on Refreshing…');
  await v.tick(550); v.posted.length = 0;
  b = v.button('send', true); await v.click(b, 1); await v.click(b, 2);
  assert.deepEqual(v.kinds(), ['press 1 disabled', 'release', 'press 2 disabled', 'release']);
  await v.tick(550); v.posted.length = 0;
  await v.click(v.button('editMessage', false, { message: 'm1' }), 1); await v.click(v.button('editMessage', false, { message: 'm2' }), 1);
  assert.deepEqual(v.kinds(), ['press 1 enabled', 'release', 'command editMessage', 'press 1 enabled', 'release', 'command editMessage'], 'Two buttons are two presses');
  const [first, second] = v.posted.filter(m => m.type === 'press');
  assert(Number.isSafeInteger(first.seq) && second.seq === first.seq + 1);
});

test('view renders wait while a button is held, at most 1 s; the click carries the summary it was drawn with', async () => {
  const v = load();
  const b = v.button('send', false, { revision: '111' });
  v.down(b); await v.tick(); v.render('<p>B</p>');
  assert.equal(v.rendered.length, 0, 'Held while pressed');
  v.up(); v.clickEvent(b, 1); await v.tick(20);
  assert.equal(v.rendered.length, 1, 'Drawn after the release');
  assert.equal(v.posted.find(m => !m.type && m.command === 'send')?.revision, '111');
  v.rendered.length = 0;
  v.down(v.button('send')); v.render('<p>C</p>'); await v.tick(1100);
  assert.equal(v.rendered.length, 1, 'A press never released does not hold the view');
  v.up(); await v.tick(20);
});
