import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { fixtureCookie, startFixtureServer } from './fixtureServer';
import type { TestApi } from '../src/extension/extension';
import { ProjectStore } from '../src/core/projectStore';

// Presses with real mouse input. `scripts/smoke.mjs --press` opens the editor's DevTools port on a free local
// port for this run only; this test, in the extension test host, presses the panel's Send button through it with
// Input.dispatchMouseEvent, the input path of a hardware mouse. So the view's own press script, the browser's
// event rules and the extension run together, which the editor test can only simulate: a press on the disabled
// button, a double click, and a redraw under a held press. Everything runs against the local fixture server.

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A minimal DevTools protocol client over the browser endpoint, with flat sessions per target. */
class DevTools {
  private id = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private constructor(private socket: WebSocket, readonly browser: string) {
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      const waiting = message.id && this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id);
      if (message.error) waiting.reject(new Error(`${message.error.message} ${message.error.data ?? ''}`)); else waiting.resolve(message.result);
    });
  }
  static async open(port: number): Promise<DevTools> {
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as { webSocketDebuggerUrl: string; Browser: string };
    const socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve); socket.addEventListener('error', reject); });
    return new DevTools(socket, version.Browser);
  }
  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = ++this.id;
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async evaluate(sessionId: string, expression: string): Promise<any> {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (result.exceptionDetails) throw new Error(`evaluate: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    return result.result.value;
  }
  close() { this.socket.close(); }
}

// Run in the webview's outer frame; the view's own document is in its `active-frame` iframe.
const VIEW = `const f=document.getElementById('active-frame');const d=f&&f.contentDocument;`;
const SEND_STATE = `(()=>{${VIEW}if(!d||!d.body)return null;const b=d.querySelector('button[data-command="send"]');const fr=f.getBoundingClientRect();const r=b&&b.getBoundingClientRect();
  return {classes:d.body.className.split(' '),send:b?{x:fr.left+r.left+r.width/2,y:fr.top+r.top+r.height/2,width:r.width,disabled:b.disabled,label:b.textContent.trim(),revision:b.dataset.revision}:null,
  notice:d.querySelector('.press-notice')?.textContent.trim()??null,updating:d.querySelector('.updating')?.textContent.trim()??null};})()`;
// Capture-phase listeners in the view's document: the events the browser delivers, to compare with the record.
const PROBE = `(()=>{${VIEW}const w=f.contentWindow;if(!w.__events){w.__events=[];for(const type of ['pointerdown','pointerup','mousedown','mouseup','click'])d.addEventListener(type,e=>{const el=e.target,b=el&&el.closest&&el.closest('button');
  w.__events.push({type,detail:e.detail,trusted:e.isTrusted,target:b?b.dataset.command:el&&el.id?'#'+el.id:el&&el.tagName});},true);}w.__events.length=0;return true;})()`;
const EVENTS = `(()=>{${VIEW}return f.contentWindow.__events||[];})()`;
const HOLD_SEND = `(()=>{${VIEW}f.contentWindow.__held=d.querySelector('button[data-command="send"]');return true;})()`;
const HELD_REDRAWN = `(()=>{${VIEW}return !f.contentWindow.__held.isConnected;})()`;
// An element that is replaced on pointerdown, as a redraw would replace it. Not a button, so the press script ignores it.
const REDRAW_PROBE = `(()=>{${VIEW}const make=id=>{const el=d.createElement('div');el.id=id;el.style.cssText='position:fixed;left:8px;top:8px;width:120px;height:40px;z-index:99999';return el;};
  const first=make('redraw-probe');first.addEventListener('pointerdown',()=>first.replaceWith(make('redraw-probe-new')));d.body.appendChild(first);const fr=f.getBoundingClientRect();return {x:fr.left+68,y:fr.top+28};})()`;
const REDRAW_CLEAN = `(()=>{${VIEW}for(const id of ['redraw-probe','redraw-probe-new'])d.getElementById(id)?.remove();return true;})()`;

export async function run(): Promise<void> {
  const fixture = await startFixtureServer({ writable: true });
  const resultPath = process.env.TURNLEAF_SMOKE_RESULT!, port = Number(process.env.TURNLEAF_PRESS_PORT);
  let devtools: DevTools | undefined;
  try {
    assert(port > 0, 'Run through scripts/smoke.mjs --press, which opens the DevTools port');
    const folder = vscode.workspace.workspaceFolders![0];
    const config = vscode.workspace.getConfiguration('turnleaf', folder.uri);
    await config.update('baseUrl', fixture.baseUrl, vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update('projectId', 'test-project', vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update('trackedFiles', ['main.tex', 'references.bib'], vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update('allowWrites', true, vscode.ConfigurationTarget.WorkspaceFolder);
    const api = await vscode.extensions.getExtension<TestApi>('zeyuxu.turnleaf')!.activate();
    assert(api, 'Test API should be exposed only in an extension test host');
    const waitFor = async (predicate: () => boolean | Promise<boolean>, label: string, ms = 10_000, step = 50) => {
      for (const end = Date.now() + ms; Date.now() < end; await sleep(step)) if (await predicate()) return;
      assert.fail(`Timed out: ${label}`);
    };
    // A linked folder with main.tex going out: sign in, Get latest, keep the local main.tex, take Overleaf's references.bib, Apply.
    await writeFile(vscode.Uri.joinPath(folder.uri, 'references.bib').fsPath, 'Existing local bibliography before the first sync.\n');
    await api.signIn(fixtureCookie);
    await vscode.commands.executeCommand('turnleaf.pull');
    const preview = api.reviewSnapshot().preview!;
    await vscode.commands.executeCommand('turnleaf.useRemoteVersion', { path: 'references.bib', preview: preview.id });
    await vscode.commands.executeCommand('turnleaf.keepLocalVersion', { path: 'main.tex', preview: preview.id });
    await sleep(700);
    await vscode.commands.executeCommand('turnleaf.applyReviewed', { preview: preview.id });
    await waitFor(() => api.summarySettled() && api.reviewView().outgoing?.files.length === 1, 'main.tex is listed as going out');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('turnleaf.showReviewPanel');

    // The workbench page takes the input; the panel's webview frame shows where Send is and what the view says.
    devtools = await DevTools.open(port);
    const targets = async () => (await devtools!.send('Target.getTargets')).targetInfos as { targetId: string; type: string; url: string }[];
    const sessions = new Map<string, string>();
    const attach = async (targetId: string) => sessions.get(targetId) ?? sessions.set(targetId, (await devtools!.send('Target.attachToTarget', { targetId, flatten: true })).sessionId).get(targetId)!;
    const workbench = (await targets()).find(t => t.type === 'page' && t.url.includes('workbench.html'));
    assert(workbench, 'The workbench page is open to DevTools');
    const page = await attach(workbench.targetId);
    let view = '';
    await waitFor(async () => {
      for (const t of (await targets()).filter(t => t.type === 'iframe' && t.url.startsWith('vscode-webview://'))) {
        const session = await attach(t.targetId), s = await devtools!.evaluate(session, SEND_STATE).catch(() => null);
        if (s?.classes.includes('panel') && s.send?.width > 0) { view = session; return true; }
      }
      return false;
    }, 'The panel shows Send', 15_000, 250);
    const state = async () => (await devtools!.evaluate(view, SEND_STATE)) as { send: { x: number; y: number; disabled: boolean; label: string; revision: string } | null; notice: string | null; updating: string | null };
    // The webview frame's place in the window, found by the frame's id in its URL.
    const point = async (at: { x: number; y: number }) => {
      const id = new URL(await devtools!.evaluate(view, 'location.href')).searchParams.get('id');
      const frame = await devtools!.evaluate(page, `(()=>{const i=[...document.querySelectorAll('iframe')].find(i=>i.src.includes('id=${id}'));if(!i)return null;const r=i.getBoundingClientRect();return {x:r.left,y:r.top};})()`);
      assert(frame, 'The panel frame is in the workbench');
      return { x: frame.x + at.x, y: frame.y + at.y };
    };
    const mouse = (type: 'mouseMoved' | 'mousePressed' | 'mouseReleased', at: { x: number; y: number }, clickCount = 1) =>
      devtools!.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount }, page);
    const click = async (at: { x: number; y: number }, clickCount = 1) => { await mouse('mouseMoved', at); await mouse('mousePressed', at, clickCount); await sleep(60); await mouse('mouseReleased', at, clickCount); };
    const events = async () => ((await devtools!.evaluate(view, EVENTS)) as { type: string; detail: number; trusted: boolean; target: string }[]);
    const kinds = async () => (await events()).map(e => `${e.type} ${e.detail}`);

    const store = new ProjectStore(folder.uri.fsPath, fixture.baseUrl, 'test-project', ['main.tex', 'references.bib']);
    const records = async (): Promise<any[]> => { await api.actionsWritten(); return (await readFile(await store.path('actions.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)); };
    const sent = async () => (await records()).filter(line => line.event === 'finished' && line.command === 'send' && line.outcome === 'sent').length;
    const said = (pattern: RegExp) => api.outputLines().filter(line => pattern.test(line)).at(-1);
    const remote = () => fixture.replies.modern[0].content;
    const main = vscode.Uri.joinPath(folder.uri, 'main.tex');
    let edits = 0;
    const editAndSave = async () => {
      const document = await vscode.workspace.openTextDocument(main), edit = new vscode.WorkspaceEdit();
      edit.insert(main, document.positionAt(document.getText().length), `Pressed edit ${++edits}.\n`);
      await vscode.workspace.applyEdit(edit); await document.save();
    };
    const enabledSend = async (label: string) => {
      await waitFor(async () => { const s = await state(); return !!s.send && !s.send.disabled && api.summarySettled(); }, label, 15_000, 20);
      return (await state()).send!;
    };
    /** The press lines and outcome lines written since `from` (a count of record lines). */
    const pressesSince = async (from: number) => {
      const lines = (await records()).slice(from);
      return lines.filter(line => line.event === 'press').map(press => ({ press, ends: lines.filter(line => line.seq === press.seq && line.event !== 'press') }));
    };
    const outcome = (ends: any[]) => ends.find(line => line.event === 'press-ended' || line.event === 'finished')?.outcome;
    const sendOnce = async (label: string) => {
      const before = await sent(); await click(await point(await enabledSend(label)));
      await waitFor(async () => await sent() === before + 1, `${label}: sent`, 20_000);
    };
    const result: Record<string, unknown> = { status: 'ready', runtime: api.runtime(), browser: devtools.browser };

    // One press on an enabled Send sends, and the browser delivers it as a click.
    let from = (await records()).length;
    await devtools.evaluate(view, PROBE);
    await sendOnce('Send is enabled');
    let [one] = await pressesSince(from);
    assert.deepEqual([one.press.surface, one.press.disabled, one.press.detail], ['panel', false, 1]);
    assert.deepEqual(one.ends.map(line => `${line.event} ${line.outcome ?? ''}`.trim()), ['received', 'finished sent'], 'A press that sent is received and finished with its seq');
    assert.deepEqual(await kinds(), ['pointerdown 0', 'mousedown 1', 'pointerup 0', 'mouseup 1', 'click 1'], 'pointerdown carries no click count');
    assert((await events()).every(e => e.trusted), 'The input reaches the view as trusted events');
    assert.match(said(/^Send press \(panel, /)!, /— sent 1 row; verified$/);
    result.pressThatSent = true;

    // A press while Send reads Refreshing… (a disabled button): the browser sends only pointer events, and it sends nothing.
    await editAndSave(); const listed = await enabledSend('Send lists the edit'); await sleep(300);
    let remoteBefore = remote();
    from = (await records()).length; await devtools.evaluate(view, PROBE);
    await editAndSave();
    await waitFor(async () => { const s = (await state()).send; return !!s?.disabled && s.label === 'Refreshing…' && s.revision === listed.revision; }, 'Send reads Refreshing…', 5_000, 10);
    const refreshing = await state();
    assert.match(refreshing.updating ?? '', /^Updating: main\.tex (saved|changed on disk)/);
    await click(await point(refreshing.send!));
    await waitFor(async () => (await pressesSince(from)).some(p => outcome(p.ends)), 'The press during the refresh ended');
    [one] = await pressesSince(from);
    assert.deepEqual([one.press.disabled, outcome(one.ends)], [true, 'summary-refreshing']);
    assert.deepEqual(await kinds(), ['pointerdown 0', 'pointerup 0'], 'A disabled button gets no mousedown and no click');
    assert.equal((await state()).notice, 'Not sent: the summary was refreshing. Press Send again when it shows Send.');
    assert.match(said(/^Send press \(panel, /)!, /— not sent: summary refreshing \(main\.tex (saved|changed on disk) [\d:]+\)$/);
    await sendOnce('Send is enabled after the refresh');
    assert.notEqual(remote(), remoteBefore);
    result.pressDuringRefresh = true;

    // A press just after the summary changed (Send still waits 650 ms) sends nothing and says so.
    await editAndSave(); const shown = await enabledSend('Send lists the next edit'); await sleep(300);
    remoteBefore = remote(); from = (await records()).length;
    await editAndSave();
    await waitFor(async () => (await state()).send?.revision !== shown.revision, 'The summary changed', 5_000, 5);
    const settling = await state();
    assert.equal(settling.send?.disabled, true, 'Send waits after a summary change');
    await click(await point(settling.send!));
    await waitFor(async () => (await pressesSince(from)).some(p => outcome(p.ends)), 'The press just after the change ended');
    [one] = await pressesSince(from);
    assert.deepEqual([one.press.disabled, outcome(one.ends)], [true, 'too-soon-after-summary-change']);
    assert.equal((await state()).notice, 'Not sent: the summary changed just now. Check it, then press Send again.');
    assert.match(said(/^Send press \(panel, /)!, /— not sent: summary changed \d+ ms before \(main\.tex (saved|changed on disk) [\d:]+\)$/);
    assert.equal(remote(), remoteBefore, 'Nothing was sent');
    await sendOnce('Send is enabled after the wait');
    result.pressTooSoon = true;

    // A double click sends once; the second press gets no notice.
    await editAndSave(); const target = await point(await enabledSend('Send lists the edit for the double click'));
    let before = await sent(); from = (await records()).length; await devtools.evaluate(view, PROBE);
    const output = api.outputLines().length;
    await click(target, 1); await sleep(90); await click(target, 2);
    await waitFor(async () => { const p = await pressesSince(from); return p.length === 2 && p.every(x => outcome(x.ends)); }, 'Both presses of the double click ended', 20_000);
    await sleep(500);
    const [first, second] = await pressesSince(from);
    assert.equal(outcome(first.ends), 'sent');
    assert.deepEqual([second.press.detail, outcome(second.ends)], [2, 'extra-click'], 'The second press is the extra click of a double click');
    assert.equal(await sent(), before + 1, 'A double click sends once');
    assert.equal((await state()).notice, null, 'The extra click gets no notice');
    assert.deepEqual((await kinds()).slice(0, 5), ['pointerdown 0', 'mousedown 1', 'pointerup 0', 'mouseup 1', 'click 1']);
    assert(api.outputLines().slice(output).some(line => /^Send press \(panel, .*— ignored: extra click of a double or triple click$/.test(line)), 'The extra click is in the output channel');
    result.doubleClick = true;

    // A press held while the panel redraws: the release lands on the new button, the click is lost, and the summary says so.
    await editAndSave(); const held = await point(await enabledSend('Send lists the edit for the held press'));
    before = await sent(); from = (await records()).length; await devtools.evaluate(view, PROBE); await devtools.evaluate(view, HOLD_SEND);
    await mouse('mouseMoved', held); await mouse('mousePressed', held);
    await editAndSave();
    await waitFor(async () => await devtools!.evaluate(view, HELD_REDRAWN), 'The panel redrew under the held press (after at most 1 s)', 5_000, 20);
    await mouse('mouseReleased', held);
    await waitFor(async () => (await pressesSince(from)).some(p => outcome(p.ends)), 'The held press ended');
    [one] = await pressesSince(from);
    assert.deepEqual([one.press.disabled, outcome(one.ends)], [false, 'lost-in-redraw']);
    assert(!(await kinds()).some(kind => kind.startsWith('click')), 'No click after a redraw between press and release');
    assert.equal((await state()).notice, 'Not sent: the panel redrew during your click. Press Send again.');
    assert.equal(await sent(), before, 'Nothing was sent');
    result.pressLostInRedraw = true;

    // The browser rule the view's hold relies on: an element replaced on pointerdown gets no click.
    await devtools.evaluate(view, PROBE);
    await click(await point(await devtools.evaluate(view, REDRAW_PROBE))); await sleep(200);
    const redraw = await events(); await devtools.evaluate(view, REDRAW_CLEAN);
    assert.deepEqual(redraw.map(e => `${e.type} ${e.target}`), ['pointerdown #redraw-probe', 'mousedown BODY', 'pointerup #redraw-probe-new', 'mouseup #redraw-probe-new'], 'A redraw between pointerdown and pointerup loses the click');
    result.redrawLosesClick = true;

    await vscode.commands.executeCommand('turnleaf.signOut');
    assert.equal(await api.sessionStored(), false);
    await writeFile(resultPath, JSON.stringify({ ...result, status: 'passed' }, null, 2));
  } catch (error) {
    await writeFile(resultPath, JSON.stringify({ status: 'failed', message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack?.split('\n').filter(line => /^\s+at /.test(line)).slice(0, 4).join('\n') : undefined }));
    throw error;
  } finally { devtools?.close(); await fixture.close(); }
}
