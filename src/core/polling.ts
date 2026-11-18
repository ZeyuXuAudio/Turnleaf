import { SyncError } from './errors';

type Timer = ReturnType<typeof setTimeout>;
export interface PollClock { set(callback: () => void, ms: number): Timer; clear(timer: Timer): void; }
const defaultClock: PollClock = { set: (callback, ms) => setTimeout(callback, ms), clear: timer => clearTimeout(timer) };

// One read at a time, scheduled from completion. Reconfiguration/disposal makes
// an older completion inert, including when a network request cannot be aborted.
export class RemotePoller {
  private timer?: Timer;
  private seconds = 0;
  private failures = 0;
  private generation = 0;
  private running = false;
  private disposed = false;
  constructor(private readonly check: () => Promise<boolean>, private readonly failed: (error: unknown) => void, private readonly clock: PollClock = defaultClock) {}
  configure(seconds: number): void {
    if (this.disposed || this.seconds === seconds) return;
    this.generation++; this.seconds = seconds; this.failures = 0;
    if (this.timer) this.clock.clear(this.timer);
    this.timer = undefined;
    if (seconds > 0) this.arm(this.generation);
  }
  succeeded(): void { this.failures = 0; }
  /** Runs the next check after `ms` (or the current backoff, if longer). */
  soon(ms: number): void {
    if (this.disposed || !this.seconds) return;
    if (this.timer) this.clock.clear(this.timer);
    const generation = this.generation, backoff = this.failures ? Math.min(300, this.seconds * 2 ** this.failures) * 1000 : 0;
    this.timer = this.clock.set(() => { this.timer = undefined; void this.tick(generation); }, Math.max(ms, backoff));
  }
  dispose(): void { this.configure(0); this.disposed = true; }
  private arm(generation: number): void {
    if (!this.seconds || this.disposed || generation !== this.generation) return;
    this.timer = this.clock.set(() => { this.timer = undefined; void this.tick(generation); }, Math.min(300, this.seconds * 2 ** this.failures) * 1000);
  }
  private async tick(generation: number): Promise<void> {
    if (generation !== this.generation || this.disposed) return;
    if (this.running) { this.arm(generation); return; }
    this.running = true;
    try { if (await this.check() && generation === this.generation) this.failures = 0; }
    catch (error) {
      if (generation === this.generation && !(error instanceof SyncError && error.code === 'cancelled')) {
        this.failures = Math.min(5, this.failures + 1); this.failed(error);
      }
    } finally { this.running = false; this.arm(generation); }
  }
}
