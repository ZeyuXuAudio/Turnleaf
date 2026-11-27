import { withOperation } from './operation';
import { SyncError, safeError } from './errors';
import { ActionResult, ActionTarget, OUTCOMES, Outcome, Refusal, nextSeq, operationLabel, sendStarted } from './actionLog';

/**
 * A command as received: `seq` pairs its two lines; for a command started by a press it is the
 * press's number (`pressed`), otherwise a new one. `surface`: where it was pressed.
 * `target`: where its record went when received, so its finished line goes there too.
 */
export interface CommandRecord { command: string; seq: number; pressed: boolean; surface?: string; received: number; target?: ActionTarget }
/** `waitMs`: time before the command ran (stopping a background check, the window's startup). */
export interface FinishedRecord extends CommandRecord { result: ActionResult; durationMs: number; waitMs: number; error?: unknown }
export interface RunnerHooks {
  /** Resolves once the window's startup work has ended. */
  ready(): Promise<unknown>;
  /** Shows progress for a command that holds the operation lock. */
  progress(mode: 'notification' | 'window', task: (signal: AbortSignal, report: (message: string) => void) => Promise<unknown>): PromiseLike<unknown>;
  received(record: CommandRecord): void;
  finished(record: FinishedRecord): void;
  /** A command that failed: pop-ups and sign-in state. `quiet`: a command without progress. */
  failed(command: string, error: unknown, quiet: boolean): void;
  /** A command refused because another operation runs. */
  busy(command: string, operation: string): void;
  /** The operation lock was taken or released. */
  changed(): void;
}

const outcomes = new Set<string>(OUTCOMES);
/** The result a command returned, or undefined when it returned none. */
export function asResult(value: unknown): ActionResult | undefined {
  return value && typeof value === 'object' && outcomes.has((value as { outcome?: unknown }).outcome as string) ? value as ActionResult : undefined;
}
export function errorResult(error: unknown): ActionResult {
  const started = typeof error === 'object' && error !== null && sendStarted.has(error);
  if (error instanceof Refusal) return { outcome: error.outcome, error: error.message };
  if (error instanceof SyncError && error.code === 'cancelled') return { outcome: 'cancelled', ...started && { sendStarted: true } };
  return { outcome: 'failed' as Outcome, error: safeError(error), ...started && { sendStarted: true } };
}

/**
 * Runs commands one Overleaf operation at a time. A command first stops a running
 * background check; a second command while one runs is refused as `busy`. Every
 * command gets a `received` and a `finished` record; a hook that throws is ignored.
 */
export class CommandRunner {
  private busy = false;
  private current: string | undefined;
  private backgroundAbort: AbortController | undefined;
  private backgroundDone: Promise<boolean> | undefined;
  constructor(private readonly hooks: RunnerHooks) {}
  /** A command holds the lock (a background check does not count). */
  isBusy(): boolean { return this.busy && !this.backgroundAbort; }
  /** What holds the lock, in words. */
  operation(): string | undefined { return this.backgroundAbort ? 'background check' : this.current ? operationLabel(this.current) : undefined; }
  abort() { this.backgroundAbort?.abort(); }
  private safe(hook: () => void) { try { hook(); } catch { /* recording never stops a command */ } }
  private record(command: string, options: { seq?: number; surface?: string }): CommandRecord {
    return { command, seq: options.seq ?? nextSeq(), pressed: options.seq !== undefined, surface: options.surface, received: Date.now() };
  }
  /** Resolves to what the command came to; never rejects. */
  async run(command: string, action: () => Promise<unknown>, options: { mode?: 'window'; seq?: number; surface?: string } = {}): Promise<ActionResult> {
    const record = this.record(command, options);
    this.safe(() => this.hooks.received(record));
    let result: ActionResult = { outcome: 'failed' }, waitMs = 0, failure: unknown;
    try {
      if (this.backgroundAbort) { this.backgroundAbort.abort(); await this.backgroundDone?.catch(() => {}); }
      waitMs = Date.now() - record.received;
      if (this.busy) {
        result = { outcome: 'busy', operation: this.operation() ?? 'another operation' };
        this.safe(() => this.hooks.busy(command, result.operation!));
        return result;
      }
      this.busy = true; this.current = command; this.safe(() => this.hooks.changed());
      try {
        await this.hooks.ready();
        waitMs = Date.now() - record.received;
        const value = await this.hooks.progress(options.mode === 'window' ? 'window' : 'notification', (signal, report) => withOperation({ signal, report }, action));
        result = asResult(value) ?? { outcome: 'done' };
      } catch (error) {
        failure = error; result = errorResult(error);
        this.safe(() => this.hooks.failed(command, error, false));
      } finally { this.busy = false; this.current = undefined; this.safe(() => this.hooks.changed()); }
      return result;
    } finally {
      const finished: FinishedRecord = { ...record, result, durationMs: Date.now() - record.received, waitMs, ...failure !== undefined && { error: failure } };
      this.safe(() => this.hooks.finished(finished));
    }
  }
  /** Moving around the review: no progress, no lock, no wait for a running operation. */
  async quietly(command: string, action: () => Promise<unknown>, options: { seq?: number; surface?: string } = {}): Promise<ActionResult> {
    const record = this.record(command, options);
    this.safe(() => this.hooks.received(record));
    let result: ActionResult = { outcome: 'failed' }, waitMs = 0, failure: unknown;
    try {
      await this.hooks.ready();
      waitMs = Date.now() - record.received;
      result = asResult(await action()) ?? { outcome: 'done' };
    } catch (error) {
      failure = error; result = errorResult(error);
      this.safe(() => this.hooks.failed(command, error, true));
    } finally {
      const finished: FinishedRecord = { ...record, result, durationMs: Date.now() - record.received, waitMs, ...failure !== undefined && { error: failure } };
      this.safe(() => this.hooks.finished(finished));
    }
    return result;
  }
  /** A background check: runs only while nothing else does, and any command stops it. False: not run. */
  background(action: () => Promise<void>, onError?: (error: unknown) => void): Promise<boolean> {
    if (this.busy) return Promise.resolve(false);
    const abort = new AbortController(); this.backgroundAbort = abort; this.busy = true;
    this.backgroundDone = (async () => {
      try { await this.hooks.ready(); await withOperation({ signal: abort.signal, report() {} }, action); return true; }
      catch (error) { onError?.(error); throw error; }
      finally { this.busy = false; this.backgroundAbort = undefined; this.safe(() => this.hooks.changed()); }
    })();
    return this.backgroundDone;
  }
}
