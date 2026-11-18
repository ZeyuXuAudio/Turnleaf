// Read-session protocol adapted from @aloth/olcli v0.14.0 (MIT).
// See THIRD_PARTY_NOTICES.md. Comment attachment is a separate guarded-adapter path.
import { ReadTransport } from './http';
import { protocolError, SyncError } from './errors';
import type { ReadObserver } from './probe';
import { withOperation, detached } from './operation';
import { commentAttachment } from './commentAttachment';
import type { DocState } from './models';

export function decodePackets(payload: string): string[] {
  if (!payload) return [];
  if (!payload.startsWith('\ufffd')) return [payload];
  const packets: string[] = [];
  let i = 0;
  while (i < payload.length) {
    if (payload[i++] !== '\ufffd') protocolError();
    const end = payload.indexOf('\ufffd', i);
    if (end < 0 || !/^\d+$/.test(payload.slice(i, end))) protocolError();
    const length = Number(payload.slice(i, end));
    i = end + 1;
    if (length > payload.length - i) protocolError();
    packets.push(payload.slice(i, i + length));
    i += length;
  }
  return packets;
}

export class ReadSocket {
  readonly updates: { doc: string; v: number; meta?: { user_id?: string; type?: string; source?: string; ts?: number } }[] = [];
  updateError = false;
  private sid = '';
  private nextId = 1;
  private readonly stop = new AbortController();
  private failure?: Error;
  private pump?: Promise<void>;
  private readonly listeners = new Set<(packet?: string, error?: Error) => void>();
  private readonly eventListeners = new Set<(name: string, args: unknown[]) => void>();
  private readonly closeListeners = new Set<(error: Error) => void>();
  constructor(private readonly transport: ReadTransport, private readonly projectId: string, private readonly observer?: ReadObserver) {}
  /** Server events (edits, comments, project changes) while the session stays open. */
  onEvent(listener: (name: string, args: unknown[]) => void): () => void { this.eventListeners.add(listener); return () => this.eventListeners.delete(listener); }
  /** Called once if the connection fails; not after a deliberate close(). */
  onClose(listener: (error: Error) => void): () => void { this.closeListeners.add(listener); return () => this.closeListeners.delete(listener); }
  get alive(): boolean { return !!this.sid && !this.failure && !this.stop.signal.aborted; }
  private pollUrl(): string {
    return this.transport.url(`/socket.io/1/xhr-polling/${encodeURIComponent(this.sid)}?projectId=${encodeURIComponent(this.projectId)}&t=${Date.now()}`);
  }
  async open(): Promise<unknown> {
    const handshake = await this.transport.get(this.transport.url(`/socket.io/1/?projectId=${encodeURIComponent(this.projectId)}&t=${Date.now()}`));
    if (!/^[\w-]+:\d+:\d+:/.test(handshake.trim())) protocolError();
    this.sid = handshake.trim().split(':')[0];
    const response = this.wait(packet => {
      if (!packet.startsWith('5:::')) return;
      const event = JSON.parse(packet.slice(4));
      // Overleaf answers a refused join with this event, then closes the connection.
      if (event.name === 'connectionRejected') {
        const reason = event.args?.[0] ?? {};
        if (reason.code === 'TooManyRequests' || /rate-limit/i.test(String(reason.message ?? ''))) throw new SyncError('Overleaf limits how often a project is opened (45 times a minute on Community Edition).', 'rate-limit');
        throw new SyncError(`Overleaf refused the read session (${String(reason.message ?? 'no reason given')}). Please retry.`, 'socket');
      }
      if (event.name === 'joinProjectResponse' && event.args?.[0]?.project) {
        this.observer?.joinProject?.(event.args[0]); return event.args[0].project;
      }
    });
    this.pump = detached(() => this.listen()).catch(error => {
      if (!this.stop.signal.aborted) {
        this.failure = error; this.listeners.forEach(listener => listener(undefined, error));
        this.closeListeners.forEach(listener => listener(error));
      }
    });
    return response;
  }
  private healthy(): void {
    if (this.failure) throw this.failure;
    if (this.stop.signal.aborted) throw new SyncError('Overleaf read session closed. Retry the operation.', 'socket');
  }
  private wait<T>(select: (packet: string) => T | undefined, timeoutMs = 10_000, fallback?: T): Promise<T> {
    this.healthy();
    return new Promise<T>((resolve, reject) => {
      const finish = (value?: T, error?: Error) => {
        clearTimeout(timer); this.listeners.delete(listener);
        if (error) reject(error); else resolve(value!);
      };
      const listener = (packet?: string, error?: Error) => {
        if (error) { finish(undefined, error); return; }
        try { const value = select(packet!); if (value !== undefined) finish(value); }
        catch (error) { finish(undefined, error as Error); }
      };
      const timer = setTimeout(() => finish(fallback, fallback === undefined ? new SyncError('Overleaf did not acknowledge the read session in time.', 'socket') : undefined), timeoutMs);
      this.listeners.add(listener);
    });
  }
  private async listen(): Promise<void> {
    while (!this.stop.signal.aborted) {
      const packets = await this.poll();
      for (const packet of packets) this.listeners.forEach(listener => listener(packet));
      // Real servers long-poll; avoid spinning against proxies/fixtures that return no-ops immediately.
      if (!packets.length || packets.every(p => p === '8::')) await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  private async poll(): Promise<string[]> {
    const packets = decodePackets(await this.transport.get(this.pollUrl(), { signal: this.stop.signal, timeoutMs: 45_000 }));
    for (const packet of packets) {
      if (packet.startsWith('2::')) await this.transport.postSocket(this.pollUrl(), '2::');
      if (packet.startsWith('0::') || packet.startsWith('7::')) throw new SyncError('Overleaf closed the read session. Please retry.', 'socket');
      if (packet.startsWith('5:::')) {
        const event = JSON.parse(packet.slice(4));
        if (event.name === 'otUpdateApplied' && event.args?.[0]) {
          this.updates.push(event.args[0]);
          // A live session can stay open for hours; checks only need recent versions.
          if (this.updates.length > 1000) this.updates.splice(0, this.updates.length - 1000);
        }
        if (event.name === 'otUpdateError') this.updateError = true;
        if (typeof event.name === 'string') this.eventListeners.forEach(listener => listener(event.name, Array.isArray(event.args) ? event.args : []));
      }
    }
    return packets;
  }
  async join(docId: string): Promise<unknown[]> {
    this.healthy();
    const id = this.nextId++;
    const response = this.wait<unknown[]>(packet => {
      const match = /^6:::(\d+)\+?(.*)$/.exec(packet);
      if (!match || Number(match[1]) !== id) return;
      const args = JSON.parse(match[2] || '[]');
      if (!Array.isArray(args) || args[0]) throw new SyncError('Overleaf could not open the requested document.', 'protocol');
      return args.slice(1);
    });
    const [, result] = await Promise.all([this.transport.postSocket(this.pollUrl(), `5:${id}+::${JSON.stringify({ name: 'joinDoc', args: [docId, { encodeRanges: true, supportsHistoryOT: true }] })}`), response]);
    return result;
  }
  async leave(docId: string): Promise<void> {
    this.healthy();
    // Do not wait for the acknowledgement; the following RPC ignores unrelated packets.
    await this.transport.postSocket(this.pollUrl(), `5:${this.nextId++}+::${JSON.stringify({ name: 'leaveDoc', args: [docId] })}`);
  }
  // Called only by OverleafReader after consuming a confirmed edit permit for
  // the reviewed text. Never retried automatically: an unclear result stays
  // fenced until Get latest. The server applies it at `doc.version`, merging,
  // never overwriting, any edit a collaborator made in between.
  async applyEdit(doc: DocState, op: unknown[], meta: Record<string, unknown>, csrf: string): Promise<void> {
    this.healthy();
    const id = this.nextId++;
    const response = this.wait<boolean>(packet => {
      const match = /^6:::(\d+)\+?(.*)$/.exec(packet);
      if (!match || Number(match[1]) !== id) return;
      const args = JSON.parse(match[2] || '[]');
      if (!Array.isArray(args) || args[0]) throw new SyncError(`Overleaf did not accept the edit to ${doc.path}. Get latest to check what reached Overleaf.`, 'edit');
      return true;
    }, 30_000);
    await Promise.all([this.transport.postContent(this.pollUrl(), `5:${id}+::${JSON.stringify({ name: 'applyOtUpdate', args: [doc.docId, { doc: doc.docId, op, v: doc.version, meta }] })}`, 'text/plain;charset=UTF-8', csrf), response]);
  }
  // Called only by OverleafReader after consuming a confirmed createThread
  // permit. It cannot submit arbitrary source edits, and is never auto-retried.
  async attachComment(doc: DocState, threadId: string, from: number, to: number, csrf: string): Promise<void> {
    this.healthy();
    const id = this.nextId++;
    const update = { doc: doc.docId, op: [commentAttachment(doc, threadId, from, to)], v: doc.version };
    const response = this.wait<boolean>(packet => {
      const match = /^6:::(\d+)\+?(.*)$/.exec(packet);
      if (!match || Number(match[1]) !== id) return;
      const args = JSON.parse(match[2] || '[]');
      if (!Array.isArray(args) || args[0]) throw new SyncError('Overleaf did not confirm the new comment anchor. Review the sync history before retrying.', 'comment');
      return true;
    });
    await Promise.all([this.transport.postContent(this.pollUrl(), `5:${id}+::${JSON.stringify({ name: 'applyOtUpdate', args: [doc.docId, update] })}`, 'text/plain;charset=UTF-8', csrf), response]);
  }
  async waitForUpload(docId: string, version: number, userId?: string): Promise<boolean> {
    const seen = () => this.updates.some(e => e.doc === docId && e.v >= version && e.meta?.type === 'external' && e.meta?.source === 'upload' && e.meta?.user_id === userId);
    this.healthy();
    if (seen()) return true;
    return this.wait(() => seen() ? true : undefined, 2_000, false);
  }
  async close(): Promise<void> {
    if (!this.sid) return;
    this.stop.abort();
    this.listeners.forEach(listener => listener(undefined, new SyncError('Read session closed.', 'socket')));
    await this.pump;
    try { await withOperation({ signal: new AbortController().signal, report() {} }, () => this.transport.postSocket(this.pollUrl(), '0::', { timeoutMs: 2_000 })); } catch { /* best-effort cleanup, even after cancellation */ }
    this.sid = '';
  }
}
