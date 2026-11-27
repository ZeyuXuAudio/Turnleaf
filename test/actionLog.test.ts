import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActionLog, ActionResult, Press, PressTracker, Refusal, SETTLE_MS, describe, operationLabel, pressNotice, pressTag, sendGate, writesStarted } from '../src/core/actionLog';
import { CommandRunner, FinishedRecord, CommandRecord, asResult, errorResult } from '../src/core/commands';
import { SyncError } from '../src/core/errors';

const key = 'a'.repeat(64);
const meta = { version: '9.9.9', session: 'window-session', pid: 4242 };
const lines = async (path: string) => (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('sendGate: a press that cannot send before any request names why', () => {
  const now = 100_000, cause = { label: 'main.tex saved', at: now - 2000 };
  assert.deepEqual(sendGate({ refreshing: false, sending: false, now }), { outcome: 'no-summary' });
  assert.deepEqual(sendGate({ shown: { changedAt: 0 }, refreshing: true, sending: true, now }), { outcome: 'busy', operation: 'Send' }, 'A Send in flight comes first');
  const refreshing = sendGate({ shown: { changedAt: 0 }, refreshing: true, refreshCause: { label: 'Overleaf changed', detail: 'live event otUpdateApplied', at: now - 1000 }, sending: false, now })!;
  assert.equal(refreshing.outcome, 'summary-refreshing');
  assert.match(refreshing.cause!, /^live event otUpdateApplied \d\d:\d\d:\d\d$/);
  const soon = sendGate({ shown: { changedAt: now - 200, cause }, refreshing: false, sending: false, now })!;
  assert.equal(soon.outcome, 'too-soon-after-summary-change'); assert.equal(soon.changedAgoMs, 200); assert.match(soon.cause!, /^main\.tex saved /);
  assert.equal(sendGate({ shown: { changedAt: now - SETTLE_MS }, refreshing: false, sending: false, now }), undefined, 'At 650 ms Send may go');
});

test('each press that did not send has its own notice; extra clicks and outcomes the summary explains have none', () => {
  const notice = (result: ActionResult, label?: string) => pressNotice(result, label);
  assert.equal(notice({ outcome: 'summary-refreshing' }), 'Not sent: the summary was refreshing. Press Send again when it shows Send.');
  assert.equal(notice({ outcome: 'too-soon-after-summary-change' }), 'Not sent: the summary changed just now. Check it, then press Send again.');
  assert.equal(notice({ outcome: 'lost-in-redraw' }), 'Not sent: the panel redrew during your click. Press Send again.');
  assert.equal(notice({ outcome: 'busy', operation: 'Get latest' }), 'Not sent: Get latest is still running. Press Send again when it has finished.');
  assert.equal(notice({ outcome: 'busy', operation: 'Send' }), 'Not sent again: Send was already running.');
  assert.equal(notice({ outcome: 'nothing-to-send' }), 'Not sent: nothing is listed to send.');
  assert.equal(notice({ outcome: 'summary-refreshing' }, 'Send undo'), 'Not sent: the summary was refreshing. Press Send undo again when it shows Send undo.');
  for (const outcome of ['sent', 'extra-click', 'no-click', 'confirmation-declined', 'summary-changed', 'no-summary', 'failed', 'cancelled', 'blocked', 'unsaved-files', 'sending-off', 'preview-open', 'workspace-changed'] as const)
    assert.equal(notice({ outcome }), undefined, outcome);
});

test('output lines say what each command or press came to', () => {
  assert.equal(describe({ outcome: 'summary-refreshing', cause: 'live event otUpdateApplied 22:37:36' }), 'not sent: summary refreshing (live event otUpdateApplied 22:37:36)');
  assert.equal(describe({ outcome: 'sent', rows: 2, verification: 'verified' }, 2400), 'sent 2 rows in 2.4 s; verified');
  assert.equal(describe({ outcome: 'summary-changed', rows: 1, overleaf: true }), 'not sent: summary changed (1 row; Overleaf changed)');
  assert.equal(describe({ outcome: 'summary-changed', rows: 3, overleaf: false }), 'not sent: summary changed (3 rows; Overleaf unchanged)');
  assert.equal(describe({ outcome: 'failed', error: 'Overleaf request failed. Please try again.', writesStarted: true }), 'failed: Overleaf request failed. Please try again. (writes had started)');
  assert.equal(describe({ outcome: 'busy', operation: 'background check' }), 'not run: background check running');
  assert.equal(describe({ outcome: 'extra-click' }), 'ignored: extra click of a double or triple click');
  assert.equal(operationLabel('turnleaf.pull'), 'Get latest'); assert.equal(operationLabel('linkProject'), 'Link project');
  assert.deepEqual(pressTag({ turnleafPress: true, surface: 'panel', seq: 3 }), { turnleafPress: true, surface: 'panel', seq: 3 });
  assert.equal(pressTag({ path: 'main.tex' }), undefined); assert.equal(pressTag('c1'), undefined);
});

test('the action record: version, window session and process on every line, one activated line per window, a rotated copy past the cap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnleaf-actions-')), reports: string[] = [];
  try {
    const log = new ActionLog(meta, message => reports.push(message), 600), path = join(root, '.turnleaf', 'projects', key, 'actions.jsonl');
    await log.write({ root, key }, { event: 'received', seq: 1, command: 'send', surface: 'panel' });
    await log.write({ root, key }, { event: 'finished', seq: 1, command: 'send', surface: 'panel', outcome: 'sent', rows: 2, durationMs: 1200, waitMs: 0, verification: 'verified' });
    const first = await lines(path);
    assert.deepEqual(first.map(line => line.event), ['activated', 'received', 'finished']);
    for (const line of first) { assert.equal(line.version, '9.9.9'); assert.equal(line.session, 'window-session'); assert.equal(line.pid, 4242); assert.match(line.time, /^\d{4}-\d\d-\d\dT/); }
    assert.equal(first[2].outcome, 'sent'); assert.equal(first[2].rows, 2);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    // Unknown fields are dropped and long strings cut, so no text other than names and safe messages lands in the record.
    await log.write({ root, key }, { event: 'finished', command: 'send', outcome: 'failed', error: 'x'.repeat(400), text: 'comment text', cookie: 'secret' } as any);
    const failed = (await lines(path)).at(-1);
    assert.equal(failed.error.length, 300); assert.equal(failed.text, undefined); assert.equal(failed.cookie, undefined);
    for (let n = 0; n < 4; n++) await log.write({ root, key }, { event: 'press', seq: n, command: 'send', surface: 'sidebar', disabled: false, detail: 1 });
    const rotated = await lines(join(root, '.turnleaf', 'projects', key, 'actions.1.jsonl')), current = await lines(path);
    assert.equal(rotated[0].event, 'activated'); assert.equal(current[0].event, 'activated', 'The new file starts with the window that writes it');
    assert(Buffer.byteLength(await readFile(path, 'utf8')) <= 600);
    assert.deepEqual(reports, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a failed record write is reported once and never thrown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnleaf-actions-')), reports: string[] = [];
  try {
    // .turnleaf is a file: the folder for the record cannot be made.
    await writeFile(join(root, '.turnleaf'), 'not a folder');
    const log = new ActionLog(meta, message => reports.push(message));
    await log.write({ root, key }, { event: 'received', command: 'send' });
    await log.write({ root, key }, { event: 'finished', command: 'send', outcome: 'sent' });
    assert.equal(reports.length, 1); assert.match(reports[0], /Action record not written \((EEXIST|ENOTDIR)\); commands are not affected/);
    await log.write({ root, key: 'not-a-key' }, { event: 'received', command: 'send' });
    assert.match(reports[1], /action-record-key/);
    await log.write(undefined, { event: 'received', command: 'openThread' });
    assert.equal(reports.length, 2, 'Without a project there is no file to write');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('presses: matched to their command, or ended as disabled, extra click, lost in a redraw or without a click', async () => {
  const pressed: Press[] = [], ended: [Press, ActionResult][] = [];
  const tracker = new PressTracker({ pressed: press => pressed.push(press), ended: (press, result) => ended.push([press, result]), disabledResult: () => ({ outcome: 'summary-refreshing', cause: 'main.tex saved 10:00:00' }) }, 30);
  const a = tracker.press('panel', { seq: 1, command: 'send', disabled: false, detail: 1 });
  tracker.release('panel', 1, false);
  assert.equal(tracker.command('panel', 1), a.seq, 'The click reaches its command');
  const b = tracker.press('sidebar', { seq: 1, command: 'send', disabled: true, detail: 1 });
  assert.notEqual(b.seq, a.seq, 'Each view counts its own presses; the record numbers them per window');
  tracker.press('panel', { seq: 2, command: 'send', disabled: false, detail: 2 });
  tracker.press('panel', { seq: 3, command: 'send', disabled: false, detail: 1 }); tracker.release('panel', 3, true);
  tracker.press('panel', { seq: 4, command: 'pull', disabled: false, detail: 1 }); tracker.release('panel', 4, false);
  tracker.press('panel', { seq: 5, command: 'send', disabled: false, detail: 1 }); tracker.release('panel', 5, false); tracker.extra('panel', 5);
  await sleep(80);
  assert.deepEqual(ended.map(([press, result]) => [press.surface, press.command, result.outcome]), [
    ['sidebar', 'send', 'summary-refreshing'], ['panel', 'send', 'extra-click'], ['panel', 'send', 'lost-in-redraw'], ['panel', 'send', 'extra-click'], ['panel', 'pull', 'no-click']]);
  assert.equal(pressed.length, 6);
  assert.equal(tracker.command('panel', 4), pressed[4].seq, 'A late command still carries its press');
  assert.equal(tracker.command('panel', undefined), undefined);
  tracker.dispose();
});

function runner(options: { ready?: Promise<unknown> } = {}) {
  const received: CommandRecord[] = [], finished: FinishedRecord[] = [], failed: string[] = [], busy: string[] = [];
  const commands = new CommandRunner({
    ready: () => options.ready ?? Promise.resolve(),
    progress: (_mode, task) => task(new AbortController().signal, () => {}),
    received: record => received.push(record), finished: record => finished.push(record),
    failed: (id, error) => failed.push(`${id}: ${error instanceof Error ? error.message : error}`), busy: (id, operation) => busy.push(`${id}: ${operation}`), changed() {},
  });
  return { commands, received, finished, failed, busy };
}

test('every command gets a received and a finished record with its press and outcome', async () => {
  const { commands, received, finished } = runner();
  await commands.run('turnleaf.pull', async () => undefined, { seq: 7, surface: 'sidebar' });
  await commands.quietly('turnleaf.openThread', async () => 'c1', { surface: 'panel' });
  await commands.run('turnleaf.send', async () => ({ outcome: 'sent', rows: 1, verification: 'verified' }));
  assert.deepEqual(received.map(r => [r.command, r.seq, r.surface]), [['turnleaf.pull', 7, 'sidebar'], ['turnleaf.openThread', undefined, 'panel'], ['turnleaf.send', undefined, undefined]]);
  assert.deepEqual(finished.map(r => [r.command, r.seq, r.result.outcome]), [['turnleaf.pull', 7, 'done'], ['turnleaf.openThread', undefined, 'done'], ['turnleaf.send', undefined, 'sent']]);
  assert(finished.every(r => r.durationMs >= 0 && r.waitMs >= 0));
  // Where the received line went is where the finished line goes.
  const filed = new CommandRunner({ ready: async () => {}, progress: (_m, task) => task(new AbortController().signal, () => {}), received: record => { record.target = { root: '/r', key }; },
    finished: record => finished.push(record), failed() {}, busy() {}, changed() {} });
  await filed.run('turnleaf.pull', async () => undefined);
  assert.deepEqual(finished.at(-1)!.target, { root: '/r', key });
});

test('a command while another runs is busy and names it; the waiting time is recorded', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { commands, finished, busy } = runner();
  const pull = commands.run('turnleaf.pull', () => gate);
  assert.equal(commands.isBusy(), true); assert.equal(commands.operation(), 'Get latest');
  await commands.run('turnleaf.send', async () => ({ outcome: 'sent' }), { seq: 2, surface: 'panel' });
  assert.deepEqual(finished.at(-1)!.result, { outcome: 'busy', operation: 'Get latest' });
  assert.deepEqual(busy, ['turnleaf.send: Get latest']);
  release(); await pull;
  assert.equal(commands.isBusy(), false);
  // A background check gives way to a command, which waits for it to stop.
  let stopped = false;
  void commands.background(async () => { await sleep(250); stopped = true; }).catch(() => {});
  assert.equal(commands.isBusy(), false, 'A background check is not a busy operation'); assert.equal(commands.operation(), 'background check');
  await commands.run('turnleaf.send', async () => ({ outcome: 'sent' }));
  assert.equal(stopped, true); assert.equal(finished.at(-1)!.result.outcome, 'sent'); assert(finished.at(-1)!.waitMs >= 200, 'The wait for the background check is recorded');
  // Startup work still running: the command waits for it.
  let started!: () => void;
  const slow = runner({ ready: new Promise<void>(resolve => { started = resolve; }) });
  const run = slow.commands.run('turnleaf.send', async () => ({ outcome: 'sent' }));
  setTimeout(started, 220); await run;
  assert(slow.finished[0].waitMs >= 200);
});

test('refusals, cancellations and failures map to their outcomes; a failing record hook never fails the command', async () => {
  const { commands, finished, failed } = runner();
  await commands.run('turnleaf.send', async () => { throw new Refusal('unsaved-files', 'Save the selected files first: unsaved edits are not in the summary.', 'stale'); });
  await commands.run('turnleaf.send', async () => { throw new SyncError('Cancelled.', 'cancelled'); });
  await commands.run('turnleaf.send', async () => { const error = new SyncError('Overleaf rejected the upload.', 'push'); writesStarted.add(error); throw error; });
  await commands.quietly('turnleaf.openThread', async () => { throw new Error('raw third-party message with details'); });
  assert.deepEqual(finished.map(r => r.result), [
    { outcome: 'unsaved-files', error: 'Save the selected files first: unsaved edits are not in the summary.' },
    { outcome: 'cancelled' },
    { outcome: 'failed', error: 'Overleaf rejected the upload.', writesStarted: true },
    { outcome: 'failed', error: 'Overleaf request failed. Please try again.' }]);
  assert.equal(failed.length, 4, 'Pop-ups and sign-in handling still see every error');
  assert.equal(asResult({ outcome: 'no-such-outcome' }), undefined); assert.equal(asResult('sent'), undefined);
  assert.deepEqual(errorResult(new Refusal('sending-off', 'Enable sending in Project setup first.', 'read-only')), { outcome: 'sending-off', error: 'Enable sending in Project setup first.' });
  // A record hook that throws (the record cannot be written) leaves the command and its result as they are.
  let ran = false;
  const broken = new CommandRunner({ ready: async () => {}, progress: (_m, task) => task(new AbortController().signal, () => {}), received() { throw new Error('disk full'); }, finished() { throw new Error('disk full'); }, failed() {}, busy() {}, changed() {} });
  await broken.run('turnleaf.send', async () => { ran = true; return { outcome: 'sent' }; });
  assert.equal(ran, true); assert.equal(broken.isBusy(), false);
});

test('a log-write failure does not block a Send: the command runs and finishes while the record cannot be written', async () => {
  const root = await mkdtemp(join(tmpdir(), 'turnleaf-actions-')), reports: string[] = [];
  try {
    await mkdir(join(root, '.turnleaf', 'projects', key, 'actions.jsonl'), { recursive: true });
    const log = new ActionLog(meta, message => reports.push(message)), results: string[] = [];
    const commands = new CommandRunner({ ready: async () => {}, progress: (_m, task) => task(new AbortController().signal, () => {}),
      received: record => void log.write({ root, key }, { event: 'received', command: record.command }),
      finished: record => { results.push(record.result.outcome); void log.write({ root, key }, { event: 'finished', command: record.command, ...record.result }); },
      failed() {}, busy() {}, changed() {} });
    await commands.run('turnleaf.send', async () => ({ outcome: 'sent', rows: 1, verification: 'verified' }));
    await log.flushed();
    assert.deepEqual(results, ['sent']);
    assert.equal(reports.length, 1); assert.match(reports[0], /EISDIR/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
