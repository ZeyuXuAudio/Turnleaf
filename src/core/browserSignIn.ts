import { spawn, ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { delimiter, join, win32 } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { SyncError } from './errors';

// The user signs in on Overleaf's own page in a dedicated browser profile.
// The DevTools protocol runs over --remote-debugging-pipe: no TCP port is
// opened, so no other local process can attach to the sign-in browser.
export function browserCandidates(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === 'darwin') {
    const apps = [['Google Chrome', 'Google Chrome'], ['Microsoft Edge', 'Microsoft Edge'], ['Brave Browser', 'Brave Browser'], ['Chromium', 'Chromium']];
    return [ '/Applications', join(env.HOME ?? '', 'Applications')].flatMap(root => apps.map(([app, binary]) => `${root}/${app}.app/Contents/MacOS/${binary}`));
  }
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter((root): root is string => !!root);
    return roots.flatMap(root => ['Google\\Chrome\\Application\\chrome.exe', 'Microsoft\\Edge\\Application\\msedge.exe', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe', 'Chromium\\Application\\chrome.exe'].map(path => win32.join(root, path)));
  }
  const names = ['google-chrome', 'google-chrome-stable', 'microsoft-edge', 'brave-browser', 'chromium', 'chromium-browser'];
  return (env.PATH ?? '').split(delimiter).filter(Boolean).flatMap(dir => names.map(name => join(dir, name)));
}
export function findBrowser(configured?: string, candidates = browserCandidates(), exists: (path: string) => boolean = existsSync): string | undefined {
  if (configured?.trim()) return exists(configured.trim()) ? configured.trim() : undefined;
  return candidates.find(exists);
}

/** Minimal DevTools-protocol client: NUL-terminated JSON messages on two pipes. */
export class DevToolsPipe {
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private failure?: Error;
  private readonly pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  constructor(private readonly output: Writable, input: Readable) {
    input.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      for (let end = this.buffer.indexOf(0); end >= 0; end = this.buffer.indexOf(0)) {
        const text = this.buffer.subarray(0, end).toString('utf8');
        this.buffer = this.buffer.subarray(end + 1);
        let message: any;
        try { message = JSON.parse(text); } catch { continue; }
        const waiter = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
        if (!waiter) continue;
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new SyncError(`Browser reported: ${String(message.error.message ?? 'error')}`, 'browser'));
        else waiter.resolve(message.result ?? {});
      }
    });
    input.on('error', () => this.fail(new SyncError('The sign-in browser connection failed.', 'browser')));
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.output.write(JSON.stringify({ id, method, params }) + '\0', error => { if (error) { this.pending.delete(id); reject(new SyncError('The sign-in browser connection failed.', 'browser')); } });
    });
  }
  fail(error: Error): void {
    this.failure ??= error;
    for (const waiter of this.pending.values()) waiter.reject(this.failure);
    this.pending.clear();
  }
}

interface Cookie { name: string; value: string; domain: string; path: string; }
const cookieFor = (cookies: Cookie[], url: URL) => cookies.find(cookie => {
  const domain = cookie.domain.replace(/^\./, '').toLowerCase(), host = url.hostname.toLowerCase();
  return cookie.name === 'overleaf_session2' && !!cookie.value && (host === domain || host.endsWith('.' + domain)) && url.pathname.startsWith(cookie.path || '/');
});
// Pages where an unauthenticated session cookie is expected; validating it there is pointless.
const signInPage = (path: string) => /^\/(login|register|logout|user\/password|saml|oauth|sso|institutional-login)/.test(path);

export interface BrowserSignInOptions {
  baseUrl: string; executable: string; profileDir: string;
  /** Resolves true only when the cookie belongs to a signed-in session. */
  validate(cookie: string): Promise<boolean>;
  signal?: AbortSignal; timeoutMs?: number; pollMs?: number; headless?: boolean;
  launch?: (executable: string, args: string[]) => ChildProcess;
}
export async function browserSignIn(options: BrowserSignInOptions): Promise<string> {
  const base = new URL(options.baseUrl);
  await mkdir(options.profileDir, { recursive: true, mode: 0o700 });
  const args = [`--user-data-dir=${options.profileDir}`, '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check', '--disable-default-apps', ...options.headless ? ['--headless=new'] : ['--new-window'], `${options.baseUrl.replace(/\/+$/, '')}/login`];
  const child = (options.launch ?? ((file, list) => spawn(file, list, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] })))(options.executable, args);
  const pipe = new DevToolsPipe(child.stdio[3] as Writable, child.stdio[4] as Readable);
  let exited = false;
  const closed = new Promise<void>(resolve => child.once('exit', () => { exited = true; pipe.fail(new SyncError('The sign-in window was closed before signing in finished.', 'cancelled')); resolve(); }));
  child.once('error', error => pipe.fail(new SyncError(`Could not start the browser: ${error.message}`, 'browser')));
  const pause = (ms: number) => new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new SyncError('Sign-in cancelled.', 'cancelled')); };
    const timer = setTimeout(() => { options.signal?.removeEventListener('abort', abort); resolve(); }, ms);
    options.signal?.addEventListener('abort', abort, { once: true });
  });
  try {
    const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000), tried = new Set<string>();
    for (;;) {
      if (options.signal?.aborted) throw new SyncError('Sign-in cancelled.', 'cancelled');
      if (Date.now() > deadline) throw new SyncError('Sign-in timed out. Run Sign in again when you are ready.', 'timeout');
      const [{ cookies = [] }, { targetInfos = [] }] = await Promise.all([pipe.send('Storage.getCookies'), pipe.send('Target.getTargets')]);
      const page = (targetInfos as { type: string; url: string }[]).filter(target => target.type === 'page').map(target => { try { return new URL(target.url); } catch { return undefined; } })
        .find(url => url?.origin === base.origin && !signInPage(url.pathname.slice(base.pathname.replace(/\/$/, '').length)));
      const session = page && cookieFor(cookies, page);
      // Validate each distinct (cookie, page) pair once, after Overleaf left its sign-in pages.
      if (session && !tried.has(`${session.value}\0${page.pathname}`)) {
        tried.add(`${session.value}\0${page.pathname}`);
        if (await options.validate(session.value)) return session.value;
      }
      await pause(options.pollMs ?? 1000);
    }
  } finally {
    // Wait for an orderly exit: the browser writes the profile's cookies while
    // shutting down, which keeps a later sign-in to one click.
    if (!exited) {
      void pipe.send('Browser.close').catch(() => {});
      await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 5000))]);
      if (!exited) child.kill();
    }
  }
}
