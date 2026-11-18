import { AsyncLocalStorage } from 'node:async_hooks';
import { SyncError } from './errors';

export interface Operation { signal: AbortSignal; report(message: string): void; }
const operations = new AsyncLocalStorage<Operation>();
export const currentOperation = () => operations.getStore();
export const withOperation = <T>(operation: Operation, action: () => Promise<T>) => operations.run(operation, action);
// Long-lived work (a live connection's listener) must not inherit, and be
// cancelled with, the operation that happened to start it.
export const detached = <T>(action: () => T): T => operations.exit(action);
export function progress(message: string): void { checkCancelled(); currentOperation()?.report(message); }
export function checkCancelled(): void {
  if (currentOperation()?.signal.aborted) throw new SyncError('Operation cancelled.', 'cancelled');
}
