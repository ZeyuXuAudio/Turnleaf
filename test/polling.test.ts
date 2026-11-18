import test from 'node:test';
import assert from 'node:assert/strict';
import { RemotePoller, PollClock } from '../src/core/polling';
import { SyncError } from '../src/core/errors';
function timerClock() {
  let next = 0;
  const tasks = new Map<number, { callback: () => void; ms: number }>();
  const clock: PollClock = { set(callback, ms) { const id = ++next; tasks.set(id, { callback, ms }); return id as any; }, clear(id) { tasks.delete(id as any); } };
  return { clock, tasks, fire() { const entry = tasks.entries().next().value; assert(entry); tasks.delete(entry[0]); entry[1].callback(); }, delay() { return tasks.values().next().value?.ms; } };
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
test('production timer defaults initialize and dispose without scheduling a read', () => {
  const poller = new RemotePoller(async () => { assert.fail('disposed timers must not read'); }, () => {});
  poller.configure(10); poller.dispose();
});
test('remote checking backs off, resets after success, and stops in manual mode', async () => {
  const time = timerClock(); let fails = true, errors = 0, calls = 0;
  const poller = new RemotePoller(async () => { calls++; if (fails) throw new Error('offline'); return true; }, () => errors++, time.clock);
  poller.configure(10); assert.equal(time.delay(), 10_000);
  time.fire(); await settle(); assert.equal(errors, 1); assert.equal(time.delay(), 20_000);
  time.fire(); await settle(); assert.equal(time.delay(), 40_000);
  fails = false; time.fire(); await settle(); assert.equal(time.delay(), 10_000);
  poller.configure(0); assert.equal(time.tasks.size, 0); assert.equal(calls, 3);
  poller.dispose(); poller.configure(10); assert.equal(time.tasks.size, 0);
});
test('a slow check never overlaps another check and cannot rearm after disposal', async () => {
  const time = timerClock(); let finish!: (result: boolean) => void, calls = 0;
  const poller = new RemotePoller(() => { calls++; return new Promise(resolve => { finish = resolve; }); }, () => {}, time.clock);
  poller.configure(10); time.fire(); assert.equal(calls, 1); assert.equal(time.tasks.size, 0);
  poller.configure(30); time.fire(); assert.equal(calls, 1); assert.equal(time.delay(), 30_000);
  poller.dispose(); finish(true); await settle(); assert.equal(time.tasks.size, 0);
});
test('cancelled background reads yield to user actions without an offline warning', async () => {
  const time = timerClock(); let errors = 0;
  const poller = new RemotePoller(async () => { throw new SyncError('cancelled', 'cancelled'); }, () => errors++, time.clock);
  poller.configure(10); time.fire(); await settle(); assert.equal(errors, 0); assert.equal(time.delay(), 10_000); poller.dispose();
});
