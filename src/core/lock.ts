import { AsyncLocalStorage } from 'node:async_hooks';
import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { SyncError } from './errors';

const lockfile = require('proper-lockfile') as {
  lock(path: string, options: Record<string, unknown>): Promise<() => Promise<void>>;
};
interface Lease { active: boolean; check(): void; }
const held = new AsyncLocalStorage<Map<string, Lease>>();

// The caller selects a shared state directory. No Git operation is needed.
// The library renews the lease and recovers locks abandoned by a crashed process.
export async function withRepositoryLock<T>(directory: string, action: () => Promise<T>): Promise<T> {
  const key = await realpath(directory), inherited = held.getStore(), existing = inherited?.get(key);
  if (existing?.active) { existing.check(); return action(); }
  let compromised: Error | undefined;
  const lease: Lease = { active: true, check() { if (compromised) throw new SyncError('The sync-state lock was lost. Stop and retry after the other editor finishes.', 'locked'); } };
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(key, {
      lockfilePath: join(key, 'turnleaf.lock'), stale: 30_000, update: 5_000,
      retries: { retries: 20, factor: 1, minTimeout: 100, maxTimeout: 100 },
      onCompromised: (error: Error) => { compromised = error; },
    });
  } catch (error: any) {
    if (error.code === 'ELOCKED') throw new SyncError('Another editor is updating this folder. Finish that Overleaf operation and retry. An interrupted lock expires after 30 seconds.', 'locked');
    throw new SyncError('Cannot acquire the sync-state lock. Check access to the local state directory.', 'locked');
  }
  try {
    return await held.run(new Map([...(inherited ?? []), [key, lease]]), async () => {
      lease.check(); const result = await action(); lease.check(); return result;
    });
  } finally {
    lease.active = false;
    if (!compromised) await release();
  }
}

export function assertRepositoryLocks(): void { held.getStore()?.forEach(lease => { if (lease.active) lease.check(); }); }
export const withSyncLock = withRepositoryLock;
