export class SyncError extends Error {
  constructor(message: string, readonly code: string, readonly status?: number, cause?: unknown) {
    super(message, { cause });
    this.name = 'SyncError';
  }
}

export class SessionExpiredError extends SyncError {
  constructor() { super('Overleaf session expired', 'session-expired'); }
}

// Never surface raw HTTP bodies, headers or third-party exception messages.
export function safeError(error: unknown): string {
  return error instanceof SyncError ? error.message : 'Overleaf request failed. Please try again.';
}

export function protocolError(): never {
  throw new SyncError('Overleaf returned an unsupported response. No project content was changed.', 'protocol');
}
