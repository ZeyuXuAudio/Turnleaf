import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { workspacePath } from './storage';
import { SyncError } from './errors';

/**
 * The press record: what happened to each button press in the project view and to
 * each command, and why. Lines go to `.turnleaf/projects/<key>/actions.jsonl` and,
 * in words, to the Turnleaf output channel. Never cookies, file contents or comment text.
 */

/** A press on Send sooner than this after the summary last changed does not send. */
export const SETTLE_MS = 650;
/** A press whose button gives no click within this time after it is released. */
export const NO_CLICK_MS = 1000;

export const OUTCOMES = ['done', 'sent', 'busy', 'no-summary', 'summary-refreshing', 'too-soon-after-summary-change', 'nothing-to-send', 'summary-changed',
  'confirmation-declined', 'cancelled', 'failed', 'preview-open', 'blocked', 'unsaved-files', 'sending-off', 'workspace-changed',
  'extra-click', 'lost-in-redraw', 'no-click', 'disabled'] as const;
export type Outcome = typeof OUTCOMES[number];

/** What one command or press came to. Only counts, names of operations and safe error text. */
export interface ActionResult {
  outcome: Outcome;
  /** busy: the operation that was running. */
  operation?: string;
  /** summary-changed: whether Overleaf changed (otherwise the local side did). */
  overleaf?: boolean;
  /** summary-changed: the rows that changed; sent: the rows sent. */
  rows?: number;
  /** summary-changed: the fresh read stopped Send (the summary now names why). */
  nowBlocked?: boolean;
  /** sent: how the read-back after writing came out. */
  verification?: 'verified' | 'mismatch' | 'warnings';
  /** failed or cancelled: Overleaf or local writes had started. */
  writesStarted?: boolean;
  /** failed and refusals: the message shown, never a raw response. */
  error?: string;
  /** summary-refreshing and too-soon: what made the summary change, with its time. */
  cause?: string;
  /** too-soon: how long before the press the summary changed. */
  changedAgoMs?: number;
}

/** A refusal with a message, shown as today; `outcome` names it in the record. */
export class Refusal extends SyncError {
  constructor(readonly outcome: Outcome, message: string, code: string) { super(message, code); this.name = 'Refusal'; }
}
/** Errors thrown after a Send started writing, so the record can say so. */
export const writesStarted = new WeakSet<object>();

/** What made the summary refresh: a short label for the panel, a detail with its time for the record. */
export interface Cause { label: string; detail?: string; at: number }
export const clock = (time: number) => new Date(time).toLocaleTimeString('en-GB', { hour12: false });
export const causeText = (cause: Cause | undefined) => cause ? `${cause.detail ?? cause.label} ${clock(cause.at)}` : undefined;

/** Why a press on Send or Send undo does not send before any request is made, or undefined. */
export function sendGate(input: { shown?: { changedAt: number; cause?: Cause }; refreshing: boolean; refreshCause?: Cause; sending: boolean; now: number }): ActionResult | undefined {
  if (!input.shown) return { outcome: 'no-summary' };
  if (input.sending) return { outcome: 'busy', operation: 'Send' };
  if (input.refreshing) return { outcome: 'summary-refreshing', ...input.refreshCause && { cause: causeText(input.refreshCause) } };
  const ago = input.now - input.shown.changedAt;
  if (ago < SETTLE_MS) return { outcome: 'too-soon-after-summary-change', changedAgoMs: Math.max(0, ago), ...input.shown.cause && { cause: causeText(input.shown.cause) } };
}

export const SEND_COMMANDS = new Set(['send', 'sendReviewed', 'sendUndo']);
const labels: Record<string, string> = {
  send: 'Send', sendReviewed: 'Send', sendUndo: 'Send undo', pull: 'Get latest', applyReviewed: 'Apply', applyAndReview: 'Apply',
  saveAll: 'Save all', checkRemote: 'Check remote', refreshComments: 'Refresh', signIn: 'Sign in', openThread: 'Open thread',
};
/** "turnleaf.linkProject" → "Link project". */
export function operationLabel(command: string): string {
  const id = command.replace(/^turnleaf\./, '');
  if (labels[id]) return labels[id];
  const words = id.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The notice shown in the summary after a press that did not send, or undefined
 * when the summary already says why (or nothing needs saying).
 */
export function pressNotice(result: ActionResult, label = 'Send'): string | undefined {
  switch (result.outcome) {
    case 'summary-refreshing': return `Not sent: the summary was refreshing. Press ${label} again when it shows ${label}.`;
    case 'too-soon-after-summary-change': return `Not sent: the summary changed just now. Check it, then press ${label} again.`;
    case 'lost-in-redraw': return `Not sent: the panel redrew during your click. Press ${label} again.`;
    case 'nothing-to-send': return 'Not sent: nothing is listed to send.';
    case 'busy': return result.operation === 'Send' || result.operation === 'Send undo'
      ? `Not sent again: ${result.operation} was already running.`
      : `Not sent: ${result.operation ?? 'another operation'} is still running. Press ${label} again when it has finished.`;
    default: return undefined;
  }
}

/** The outcome in words, for the output channel. */
export function describe(result: ActionResult, durationMs?: number): string {
  const r = result, took = durationMs !== undefined && durationMs >= 1000 ? ` in ${(durationMs / 1000).toFixed(1)} s` : '';
  const why = (text: string) => r.cause ? `${text} (${r.cause})` : text;
  switch (r.outcome) {
    case 'done': return `done${took}`;
    case 'sent': return `sent${r.rows !== undefined ? ` ${r.rows} ${r.rows === 1 ? 'row' : 'rows'}` : ''}${took}; ${r.verification === 'mismatch' ? 'verification failed' : r.verification === 'warnings' ? 'verified with concurrency warnings' : 'verified'}`;
    case 'busy': return `not run: ${r.operation ?? 'another operation'} running`;
    case 'no-summary': return 'not sent: no summary shown yet';
    case 'summary-refreshing': return why('not sent: summary refreshing');
    case 'too-soon-after-summary-change': return why(`not sent: summary changed ${r.changedAgoMs ?? '?'} ms before`);
    case 'nothing-to-send': return 'not sent: nothing listed';
    case 'summary-changed': return r.nowBlocked ? 'not sent: the fresh read found a stop, now shown in the summary'
      : `not sent: summary changed (${r.rows ?? '?'} ${r.rows === 1 ? 'row' : 'rows'}; ${r.overleaf ? 'Overleaf changed' : 'Overleaf unchanged'})`;
    case 'confirmation-declined': return 'not sent: confirmation declined';
    case 'cancelled': return `cancelled${r.writesStarted ? ' after writes started' : ''}${took}`;
    case 'failed': return `failed${took}: ${r.error ?? 'unknown error'}${r.writesStarted ? ' (writes had started)' : ''}`;
    case 'extra-click': return 'ignored: extra click of a double or triple click';
    case 'lost-in-redraw': return 'not run: the panel redrew during the click';
    case 'no-click': return 'not run: no click followed';
    case 'disabled': return 'not run: button disabled';
    default: return `not run: ${r.error ?? r.outcome}`;
  }
}

/** Where a project's record goes: its workspace folder and project key. */
export interface ActionTarget { root: string; key: string }
export type ActionEntry = { event: 'press' | 'press-ended' | 'received' | 'finished'; seq?: number; command?: string; surface?: string; disabled?: boolean; detail?: number; durationMs?: number; waitMs?: number } & Partial<ActionResult>;
const fields = ['event', 'seq', 'command', 'surface', 'disabled', 'detail', 'outcome', 'operation', 'overleaf', 'rows', 'nowBlocked', 'verification', 'writesStarted', 'error', 'cause', 'changedAgoMs', 'durationMs', 'waitMs'] as const;
/** Only the known fields, strings cut to 300 characters. */
function clean(entry: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of fields) {
    const value = entry[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') out[key] = value.length > 300 ? value.slice(0, 299) + '…' : value;
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = value;
  }
  return out;
}

/**
 * Appends lines to `actions.jsonl`, one write at a time, with one rotated copy
 * (`actions.1.jsonl`) past `limit` bytes. A failed write is reported once per
 * error code and never thrown: the command it records goes on regardless.
 */
export class ActionLog {
  private queue: Promise<void> = Promise.resolve();
  private readonly started = new Set<string>();
  private readonly reported = new Set<string>();
  constructor(private readonly meta: { version: string; session: string; pid: number; app?: string; editor?: string }, private readonly report: (message: string) => void, private readonly limit = 1 << 20) {}
  write(target: ActionTarget | undefined, entry: ActionEntry): Promise<void> {
    if (!target) return Promise.resolve();
    const time = new Date().toISOString();
    const task = this.queue.then(() => this.append(target, entry, time)).catch(error => this.failed(error));
    this.queue = task;
    return task;
  }
  /** Resolves once every write queued so far has ended. */
  flushed(): Promise<void> { return this.queue; }
  private line(time: string, entry: Record<string, unknown>) {
    return JSON.stringify({ time, ...entry, version: this.meta.version, session: this.meta.session, pid: this.meta.pid }) + '\n';
  }
  private async append(target: ActionTarget, entry: ActionEntry, time: string) {
    if (!/^[0-9a-f]{64}$/.test(target.key)) throw new SyncError('Invalid project key.', 'action-record-key');
    const path = await workspacePath(target.root, `.turnleaf/projects/${target.key}/actions.jsonl`);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const activated = () => this.line(time, { event: 'activated', ...this.meta.app && { app: this.meta.app }, ...this.meta.editor && { editor: this.meta.editor } });
    let lines = (this.started.has(path) ? '' : activated()) + this.line(time, clean(entry));
    const size = await stat(path).then(info => info.size, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return 0; throw error; });
    if (size && size + Buffer.byteLength(lines) > this.limit) {
      await rename(path, path.replace(/\.jsonl$/, '.1.jsonl'));
      // Each file starts with the window that writes it.
      if (this.started.has(path)) lines = activated() + lines;
    }
    await appendFile(path, lines, { mode: 0o600 });
    this.started.add(path);
  }
  private failed(error: unknown) {
    const code = error instanceof SyncError ? error.code : (error as NodeJS.ErrnoException)?.code ?? 'unknown';
    if (this.reported.has(code)) return;
    this.reported.add(code);
    this.report(`Action record not written (${code}); commands are not affected. Later failures with this code are not reported.`);
  }
}

/** The last argument of a command forwarded from a view: which press (if any) and where. */
export interface PressTag { turnleafPress: true; seq?: number; surface: string }
export function pressTag(value: unknown): PressTag | undefined {
  const tag = value as PressTag | undefined;
  return tag && typeof tag === 'object' && tag.turnleafPress === true && typeof tag.surface === 'string' ? tag : undefined;
}

/** A press as the project view reports it on pointerdown. */
export interface PressMessage { seq: number; command: string; disabled: boolean; detail: number }
/** `target`: where the press line went, so the line that ends it goes there too. */
export interface Press { seq: number; command: string; surface: string; disabled: boolean; detail: number; at: number; target?: ActionTarget }
/**
 * Follows each press from pointerdown to its command. A press either reaches its
 * command (`matched`), or ends here: disabled (with the reason `disabledResult`
 * gives), an extra click of a double click, lost when the panel redrew under it,
 * or no click after the release.
 */
export class PressTracker {
  private next = 0;
  private readonly open = new Map<string, { press: Press; timer?: ReturnType<typeof setTimeout> }>();
  private readonly recent = new Map<string, number>();
  constructor(private readonly hooks: { pressed(press: Press): void; ended(press: Press, result: ActionResult): void; disabledResult(command: string): ActionResult }, private readonly noClickMs = NO_CLICK_MS) {}
  private key(surface: string, local: number) { return `${surface}:${local}`; }
  press(surface: string, message: PressMessage): Press {
    const press: Press = { seq: ++this.next, command: message.command, surface, disabled: message.disabled, detail: message.detail, at: Date.now() };
    const key = this.key(surface, message.seq);
    this.recent.set(key, press.seq);
    if (this.recent.size > 200) this.recent.delete(this.recent.keys().next().value!);
    this.hooks.pressed(press);
    if (message.detail > 1) this.hooks.ended(press, { outcome: 'extra-click' });
    else if (message.disabled) this.hooks.ended(press, this.hooks.disabledResult(message.command));
    // Released or not, a press that reaches no command within 10 s has ended.
    else this.open.set(key, { press, timer: setTimeout(() => this.end(key, { outcome: 'no-click' }), 10 * this.noClickMs) });
    return press;
  }
  /** pointerup: `lost` when the pressed button was redrawn, so no click follows. */
  release(surface: string, local: number, lost: boolean) {
    const key = this.key(surface, local), entry = this.open.get(key);
    if (!entry) return;
    if (lost) { this.end(key, { outcome: 'lost-in-redraw' }); return; }
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.end(key, { outcome: 'no-click' }), this.noClickMs);
  }
  /** A click the view ignored as part of a double or triple click. */
  extra(surface: string, local: number) { this.end(this.key(surface, local), { outcome: 'extra-click' }); }
  /** The command of a press: its window-wide sequence number, if the press is known. */
  command(surface: string, local: number | undefined): number | undefined {
    if (local === undefined) return;
    const key = this.key(surface, local), entry = this.open.get(key);
    if (entry) { clearTimeout(entry.timer); this.open.delete(key); }
    return this.recent.get(key);
  }
  private end(key: string, result: ActionResult) {
    const entry = this.open.get(key);
    if (!entry) return;
    clearTimeout(entry.timer); this.open.delete(key);
    this.hooks.ended(entry.press, result);
  }
  dispose() { for (const entry of this.open.values()) clearTimeout(entry.timer); this.open.clear(); }
}
