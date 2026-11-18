import * as http from 'node:http';
import * as https from 'node:https';
import { SessionExpiredError, SyncError } from './errors';
import { currentOperation } from './operation';
export interface RequestOptions { signal?: AbortSignal; timeoutMs?: number; }
/** The largest answer read as text. A download (`ReadTransport.download`) sets its own limit. */
const textLimit = 16 * 1024 * 1024;

export function normalizeBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new SyncError('Enter a valid Overleaf server URL.', 'configuration'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new SyncError('The server URL must use HTTP or HTTPS without credentials, query or fragment.', 'configuration');
  }
  return url.href.replace(/\/+$/, '');
}

export class ReadTransport {
  readonly baseUrl: string;
  private readonly cookies = new Map<string, string>();
  constructor(baseUrl: string, cookie: string, private readonly timeoutMs = 10_000) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    if (!cookie.trim() || /[\r\n;\x00-\x20]/.test(cookie.trim())) {
      throw new SyncError('Enter the session cookie value only.', 'configuration');
    }
    this.cookies.set('overleaf_session2', cookie.trim());
  }

  get sessionCookie(): string { return this.cookies.get('overleaf_session2')!; }
  url(path: string): string { return this.baseUrl + path; }

  async get(url: string, options: RequestOptions = {}): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      try { return await this.request(url, 'GET', undefined, 0, {}, options); }
      catch (error) {
        if (!(error instanceof SyncError) || error.status !== 429 || attempt >= 2) throw error;
        await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt));
      }
    }
  }

  /** A GET whose answer is kept as bytes, up to `limit` bytes; never retried beyond a rate limit, like `get`. */
  async download(url: string, limit: number, options: RequestOptions = {}): Promise<Buffer> {
    for (let attempt = 0; ; attempt++) {
      try { return await this.requestBytes(url, 'GET', undefined, 0, {}, options, limit); }
      catch (error) {
        if (!(error instanceof SyncError) || error.status !== 429 || attempt >= 2) throw error;
        await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt));
      }
    }
  }

  // Socket.IO uses POST for read-session control. It is not a content-write API.
  async postSocket(url: string, packet: string, options: RequestOptions = {}): Promise<void> {
    if (!new URL(url).pathname.startsWith(new URL(this.baseUrl).pathname.replace(/\/$/, '') + '/socket.io/1/xhr-polling/')) {
      throw new SyncError('Blocked a non-socket POST in the read-only client.', 'read-only');
    }
    if (!['0::', '2::'].includes(packet)) {
      const match = /^5:\d+\+::(.+)$/.exec(packet);
      let event: { name?: string } = {};
      try { event = match ? JSON.parse(match[1]) : {}; } catch { /* blocked below */ }
      if (!['joinDoc', 'leaveDoc'].includes(event.name ?? '')) {
        throw new SyncError('Blocked a write operation in the read-only client.', 'read-only');
      }
    }
    await this.request(url, 'POST', packet, 0, {}, options);
  }

  async postContent(url: string, body: Buffer | string, contentType: string, csrf: string, options: RequestOptions & { accept?: string } = {}): Promise<string> {
    // Only the guarded adapter invokes this method. No retries of ambiguous writes.
    return this.request(url, 'POST', body, 0, { 'Content-Type': contentType, 'X-Csrf-Token': csrf, ...options.accept && { Accept: options.accept } }, options);
  }
  async deleteContent(url: string, csrf: string): Promise<string> {
    return this.request(url, 'DELETE', '', 0, { 'X-Csrf-Token': csrf });
  }

  private async request(address: string, method: 'GET' | 'POST' | 'DELETE', body?: string | Buffer, redirects = 0, extraHeaders: http.OutgoingHttpHeaders = {}, options: RequestOptions = {}): Promise<string> {
    return (await this.requestBytes(address, method, body, redirects, extraHeaders, options, textLimit)).toString('utf8');
  }
  private async requestBytes(address: string, method: 'GET' | 'POST' | 'DELETE', body: string | Buffer | undefined, redirects: number, extraHeaders: http.OutgoingHttpHeaders, options: RequestOptions, limit: number): Promise<Buffer> {
    const signals = [...new Set([options.signal, currentOperation()?.signal].filter((signal): signal is AbortSignal => !!signal))];
    if (signals.some(signal => signal.aborted)) throw new SyncError('Operation cancelled.', 'cancelled');
    const url = new URL(address);
    if (url.origin !== new URL(this.baseUrl).origin || url.username || url.password) {
      throw new SyncError('Blocked a request outside the configured Overleaf server origin.', 'origin');
    }
    if (/\/login\/?$/.test(url.pathname)) throw new SessionExpiredError();
    const response = await new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
      const headers: http.OutgoingHttpHeaders = {
        Cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '),
        'User-Agent': 'Turnleaf', 'Accept-Encoding': 'identity',
      };
      if (body !== undefined) {
        headers['Content-Type'] = 'text/plain;charset=UTF-8';
        headers['Content-Length'] = Buffer.byteLength(body);
      }
      Object.assign(headers, extraHeaders);
      const request = (url.protocol === 'https:' ? https : http).request(url, { method, headers }, res => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > limit) {
            request.destroy(new SyncError('Overleaf response exceeded the read limit.', 'size'));
          } else chunks.push(chunk);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', () => reject(new SyncError('Overleaf connection was interrupted.', 'network')));
      });
      const abort = () => { request.destroy(new SyncError('Operation cancelled.', 'cancelled')); };
      signals.forEach(signal => signal.addEventListener('abort', abort, { once: true }));
      const timer = setTimeout(() => request.destroy(new SyncError('Overleaf request timed out.', 'timeout')), options.timeoutMs ?? this.timeoutMs);
      request.on('close', () => { clearTimeout(timer); signals.forEach(signal => signal.removeEventListener('abort', abort)); });
      request.on('error', error => reject(error instanceof SyncError ? error : new SyncError('Could not connect to Overleaf.', 'network')));
      request.end(body);
    });
    for (const header of response.headers['set-cookie'] ?? []) {
      const pair = /^([^=;\s]+)=([^;]*)/.exec(header);
      if (pair && !/[\r\n]/.test(pair[2])) this.cookies.set(pair[1], pair[2]);
    }
    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
      if (redirects >= 5) throw new SyncError('Overleaf redirected too many times.', 'redirect');
      const target = new URL(response.headers.location, url).href;
      if (method !== 'GET' && new URL(target).pathname !== url.pathname) {
        throw new SyncError('Blocked a socket redirect to a different endpoint.', 'read-only');
      }
      // request() checks the new origin before attaching any cookie.
      return this.requestBytes(target, method, body, redirects + 1, extraHeaders, options, limit);
    }
    if (response.status === 401) throw new SessionExpiredError();
    if (response.status < 200 || response.status >= 300) {
      throw new SyncError(`Overleaf request failed (HTTP ${response.status}).`, 'http', response.status);
    }
    return response.body;
  }
}
