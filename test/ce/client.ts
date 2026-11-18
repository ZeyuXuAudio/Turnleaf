// Test-harness client for a throwaway Overleaf Community Edition instance (scripts/ce.mjs).
// Unlike the extension it writes: it registers the admin, logs in, creates a project and seeds
// comment threads and tracked changes. It is never bundled into the extension.
import { decodePackets } from '../../src/core/socket';

export class CeError extends Error {}

/** A cookie-jar HTTP client for one browser-like session. */
export class CeSession {
  readonly cookies = new Map<string, string>();
  constructor(readonly baseUrl: string) {}

  /** Sent as X-Csrf-Token on every POST and DELETE once known, so request bodies hold only schema fields. */
  csrfToken?: string;

  async request(path: string, init: { method?: string; json?: unknown; form?: FormData; text?: string; accept?: string; follow?: boolean } = {}, redirects = 0): Promise<{ status: number; body: string; location?: string }> {
    const headers: Record<string, string> = { Accept: init.accept ?? 'application/json, text/html' };
    const method = init.method ?? (init.json !== undefined || init.form || init.text !== undefined ? 'POST' : 'GET');
    if (this.csrfToken && method !== 'GET' && !path.startsWith('/socket.io/')) headers['X-Csrf-Token'] = this.csrfToken;
    if (this.cookies.size) headers.Cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    let body: string | FormData | undefined;
    if (init.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(init.json); }
    else if (init.text !== undefined) { headers['Content-Type'] = 'text/plain;charset=UTF-8'; body = init.text; }
    else body = init.form;
    const response = await fetch(new URL(path, this.baseUrl), { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(60_000) });
    for (const header of response.headers.getSetCookie()) {
      const pair = /^([^=;\s]+)=([^;]*)/.exec(header);
      if (pair) this.cookies.set(pair[1], pair[2]);
    }
    const text = await response.text(), location = response.headers.get('location') ?? undefined;
    if (location && [301, 302, 303].includes(response.status) && method === 'GET' && init.follow !== false && redirects < 5) {
      const target = new URL(location, new URL(path, this.baseUrl));
      if (target.origin === new URL(this.baseUrl).origin) return this.request(target.pathname + target.search, init, redirects + 1);
    }
    return { status: response.status, body: text, location };
  }
  async ok(path: string, init: Parameters<CeSession['request']>[1] = {}): Promise<string> {
    const response = await this.request(path, init);
    if (response.status < 200 || response.status >= 300) throw new CeError(`${init.method ?? (init.json !== undefined || init.form || init.text !== undefined ? 'POST' : 'GET')} ${path.split('?')[0].replace(/[0-9a-f]{24}/g, ':id')} returned HTTP ${response.status}${response.location ? ` to ${response.location}` : ''}: ${response.body.slice(0, 200).replace(/\s+/g, ' ')}`);
    return response.body;
  }
  async json<T = any>(path: string, init: Parameters<CeSession['request']>[1] = {}): Promise<T> {
    const body = await this.ok(path, init);
    try { return JSON.parse(body); } catch { throw new CeError(`${path} did not return JSON.`); }
  }
  /** Loads a page and keeps its CSRF token (the `ol-csrfToken` meta tag) for later writes. */
  async page(path: string): Promise<string> {
    const html = await this.ok(path, { accept: 'text/html' });
    const token = this.meta(html, 'ol-csrfToken');
    if (!token) throw new CeError(`No CSRF token on ${path}.`);
    this.csrfToken = token;
    return html;
  }
  meta(html: string, name: string): string | undefined {
    const tag = new RegExp(`<meta\\s[^>]*\\bname="${name}"[^>]*>`).exec(html)?.[0];
    const raw = tag && /\scontent="([^"]*)"/.exec(tag)?.[1];
    return raw?.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }
}

/** A Socket.IO 0.9 xhr-polling connection that can send edits, for seeding only. */
export class CeSocket {
  private sid = '';
  private nextId = 1;
  private readonly inbox: string[] = [];
  joinProjectResponse: any;
  constructor(private readonly session: CeSession, private readonly projectId: string) {}
  private path(): string { return `/socket.io/1/xhr-polling/${this.sid}?projectId=${this.projectId}&t=${Date.now()}`; }

  async open(): Promise<any> {
    const handshake = (await this.session.ok(`/socket.io/1/?projectId=${this.projectId}&t=${Date.now()}`)).trim();
    const [sid, , , transports] = handshake.split(':');
    if (!sid || !transports?.split(',').includes('xhr-polling')) throw new CeError(`Socket.IO handshake does not offer xhr-polling: ${transports ?? handshake.slice(0, 80)}`);
    this.sid = sid;
    const event = await this.waitFor(packet => {
      if (!packet.startsWith('5:::')) return undefined;
      const value = JSON.parse(packet.slice(4));
      if (value.name === 'connectionRejected') throw new CeError(`Socket connection rejected: ${JSON.stringify(value.args).slice(0, 200)}`);
      return value.name === 'joinProjectResponse' ? value : undefined;
    });
    this.joinProjectResponse = event.args[0];
    return event.args[0];
  }
  private async poll(): Promise<void> {
    for (const packet of decodePackets(await this.session.ok(this.path()))) {
      if (packet.startsWith('2::')) await this.session.ok(this.path(), { text: '2::' });
      else if (packet.startsWith('0::') || packet.startsWith('7::')) throw new CeError(`Socket closed by the server: ${packet.slice(0, 200)}`);
      else this.inbox.push(packet);
    }
  }
  private async waitFor<T>(match: (packet: string) => T | undefined, attempts = 20): Promise<T> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      for (let i = 0; i < this.inbox.length; i++) {
        const value = match(this.inbox[i]);
        if (value !== undefined) { this.inbox.splice(0, i + 1); return value; }
      }
      this.inbox.length = 0;
      await this.poll();
    }
    throw new CeError('Timed out waiting for a Socket.IO reply.');
  }
  /** Emits an event with an acknowledgement and returns the acknowledgement arguments. */
  async emit(name: string, ...args: unknown[]): Promise<unknown[]> {
    const id = this.nextId++;
    await this.session.ok(this.path(), { text: `5:${id}+::${JSON.stringify({ name, args })}` });
    return this.waitFor(packet => {
      const match = /^6:::(\d+)\+?(.*)$/s.exec(packet);
      if (!match || Number(match[1]) !== id) return undefined;
      const reply = JSON.parse(match[2] || '[]');
      if (reply[0]) throw new CeError(`${name} failed: ${JSON.stringify(reply[0]).slice(0, 300)}`);
      return reply.slice(1) as unknown[];
    });
  }
  async close(): Promise<void> {
    if (!this.sid) return;
    try { await this.session.request(this.path(), { text: '0::' }); } catch { /* best effort */ }
    this.sid = '';
  }
}
