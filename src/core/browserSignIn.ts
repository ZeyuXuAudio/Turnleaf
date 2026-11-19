import { spawn, execFile, ChildProcess } from 'node:child_process';
import { closeSync, existsSync, openSync, readlinkSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { hostname } from 'node:os';
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

export const noAnswerMessage = 'The sign-in browser did not answer Turnleaf. Its remote debugging may be turned off by an administrator. Set turnleaf.browserPath to another Chromium-based browser, or paste a session cookie instead.';
export const policyMessage = "This browser's remote debugging is turned off by an administrator (policy RemoteDebuggingAllowed), and Sign in with browser needs it. Set turnleaf.browserPath to another Chromium-based browser, or paste a session cookie instead.";
// What Chromium prints on stderr when the RemoteDebuggingAllowed policy is false;
// it then opens the window but never reads the DevTools pipe.
const policyNotice = /remote debugging is disallowed/i;

/** Minimal DevTools-protocol client: NUL-terminated JSON messages on two pipes. */
export class DevToolsPipe {
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  /** True once the browser answered any request on the pipe. */
  answered = false;
  private failure?: Error;
  private readonly pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  /** A request without a reply after `replyMs` fails the pipe: a browser that ignores the pipe never answers. */
  constructor(private readonly output: Writable, input: Readable, private readonly replyMs = 20_000) {
    input.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      for (let end = this.buffer.indexOf(0); end >= 0; end = this.buffer.indexOf(0)) {
        const text = this.buffer.subarray(0, end).toString('utf8');
        this.buffer = this.buffer.subarray(end + 1);
        let message: any;
        try { message = JSON.parse(text); } catch { continue; }
        const waiter = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
        if (typeof message.id === 'number') this.answered = true;
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
      const timer = setTimeout(() => this.fail(new SyncError(this.answered ? 'The sign-in browser stopped answering Turnleaf. Close the window and sign in again.' : noAnswerMessage, 'browser-no-answer')), this.replyMs);
      const done = () => { clearTimeout(timer); this.pending.delete(id); };
      this.pending.set(id, { resolve: value => { done(); resolve(value); }, reject: error => { done(); reject(error); } });
      this.output.write(JSON.stringify({ id, method, params }) + '\0', error => { if (error) { done(); reject(new SyncError('The sign-in browser connection failed.', 'browser')); } });
    });
  }
  fail(error: Error): void {
    this.failure ??= error;
    for (const waiter of [...this.pending.values()]) waiter.reject(this.failure);
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

// A Chromium profile can be open in one browser process only. A second launch
// with the same --user-data-dir hands its URL to the running process and exits
// at once, before it answers on the DevTools pipe.
export const leftoverWindowMessage = 'A Turnleaf sign-in window is still open from an earlier attempt. Close it (quit that browser window) and try again.';
export class LeftoverSignInWindowError extends SyncError {
  /** The process holding the profile, when the platform names it (macOS and Linux). */
  constructor(readonly pid?: number) { super(leftoverWindowMessage, 'sign-in-window-open'); this.name = 'LeftoverSignInWindowError'; }
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } };
/** Whether a running browser holds the profile, and its process ID where the lock records one. */
export function profileHolder(profileDir: string, platform: NodeJS.Platform = process.platform): { pid?: number } | undefined {
  if (platform === 'win32') {
    // Windows keeps `lockfile` open without sharing while the profile is in use.
    try { closeSync(openSync(join(profileDir, 'lockfile'), 'r+')); return undefined; }
    catch (error) { return ['EBUSY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '') ? {} : undefined; }
  }
  // Elsewhere `SingletonLock` is a symbolic link to "<host name>-<process ID>".
  let target: string;
  try { target = readlinkSync(join(profileDir, 'SingletonLock')); } catch { return undefined; }
  const split = target.lastIndexOf('-'), pid = Number(target.slice(split + 1));
  if (split < 0 || target.slice(0, split) !== hostname() || !Number.isInteger(pid) || pid <= 0 || !alive(pid)) return undefined;
  return { pid };
}
const commandLine = (pid: number) => new Promise<string>(resolve => execFile('ps', ['-o', 'command=', '-p', String(pid)], (error, stdout) => resolve(error ? '' : String(stdout).trim())));
/**
 * Quits the browser left holding a sign-in profile. Only a process whose command
 * line names this profile is signalled, so a reused process ID is never hit.
 * Resolves true once no browser holds the profile.
 */
export async function closeLeftoverSignInBrowser(profileDir: string, waitMs = 5000): Promise<boolean> {
  const pid = profileHolder(profileDir)?.pid;
  if (pid === undefined) return !profileHolder(profileDir);
  if (!` ${await commandLine(pid)} `.includes(` --user-data-dir=${profileDir} `)) return false;
  // SIGTERM lets the browser shut down in order and write the profile's cookies.
  try { process.kill(pid, 'SIGTERM'); } catch { return !alive(pid); }
  for (const end = Date.now() + waitMs; Date.now() < end && alive(pid);) await new Promise(resolve => setTimeout(resolve, 100));
  return !alive(pid);
}

// Sign-ins in progress, so that the extension can close their windows when it stops.
const running = new Set<{ stop: AbortController; done: Promise<unknown> }>();
/** Ends every sign-in in progress and waits until its browser has closed. */
export async function closeSignInBrowsers(): Promise<void> {
  const list = [...running];
  for (const entry of list) entry.stop.abort();
  await Promise.all(list.map(entry => entry.done.catch(() => {})));
}

export interface BrowserSignInOptions {
  baseUrl: string; executable: string; profileDir: string;
  /** Resolves true only when the cookie belongs to a signed-in session. */
  validate(cookie: string): Promise<boolean>;
  signal?: AbortSignal; timeoutMs?: number; pollMs?: number; headless?: boolean;
  /** How long one DevTools request may wait for its reply (default 20 s). */
  replyMs?: number;
  /** How soon an unaccepted (cookie, page) pair is checked again (default 15 s). */
  retryMs?: number;
  /** Progress notes for the output channel; never contains the cookie. */
  log?: (message: string) => void;
  launch?: (executable: string, args: string[]) => ChildProcess;
}
export async function browserSignIn(options: BrowserSignInOptions): Promise<string> {
  const stop = new AbortController(), forward = () => stop.abort();
  if (options.signal?.aborted) stop.abort(); else options.signal?.addEventListener('abort', forward, { once: true });
  const entry = { stop, done: signInWith(options, stop.signal) };
  running.add(entry);
  try { return await entry.done; }
  finally { running.delete(entry); options.signal?.removeEventListener('abort', forward); }
}
async function signInWith(options: BrowserSignInOptions, signal: AbortSignal): Promise<string> {
  const base = new URL(options.baseUrl);
  await mkdir(options.profileDir, { recursive: true, mode: 0o700 });
  const args = [`--user-data-dir=${options.profileDir}`, '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check', '--disable-default-apps', ...options.headless ? ['--headless=new'] : ['--new-window'], `${options.baseUrl.replace(/\/+$/, '')}/login`];
  const child = (options.launch ?? ((file, list) => spawn(file, list, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] })))(options.executable, args);
  const pipe = new DevToolsPipe(child.stdio[3] as Writable, child.stdio[4] as Readable, options.replyMs);
  // Read stderr only for the policy notice (keeping a short tail across chunks), so the pipe never fills.
  let errorTail = '';
  (child.stdio[2] as Readable | null)?.on('data', (chunk: Buffer) => {
    errorTail = (errorTail + chunk.toString('utf8')).slice(-400);
    if (!pipe.answered && policyNotice.test(errorTail)) pipe.fail(new SyncError(policyMessage, 'browser-policy'));
  });
  const log = (message: string) => options.log?.(message);
  let exited = false;
  const closed = new Promise<void>(resolve => child.once('exit', () => {
    exited = true;
    const holder = pipe.answered ? undefined : profileHolder(options.profileDir);
    pipe.fail(holder && holder.pid !== child.pid ? new LeftoverSignInWindowError(holder.pid) : new SyncError('The sign-in window was closed before signing in finished.', 'cancelled'));
    resolve();
  }));
  child.once('error', error => pipe.fail(new SyncError(`Could not start the browser: ${error.message}`, 'browser')));
  const pause = (ms: number) => new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(new SyncError('Sign-in cancelled.', 'cancelled')); return; }
    const abort = () => { clearTimeout(timer); reject(new SyncError('Sign-in cancelled.', 'cancelled')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000), tried = new Map<string, number>();
    let connected = false, lastPage = '';
    for (;;) {
      if (signal.aborted) throw new SyncError('Sign-in cancelled.', 'cancelled');
      if (Date.now() > deadline) throw new SyncError('Sign-in timed out. Run Sign in again when you are ready.', 'timeout');
      const [{ cookies = [] }, { targetInfos = [] }] = await Promise.all([pipe.send('Storage.getCookies'), pipe.send('Target.getTargets')]);
      if (!connected) { connected = true; log('Sign-in browser connected; waiting for an Overleaf page after signing in.'); }
      const page = (targetInfos as { type: string; url: string }[]).filter(target => target.type === 'page').map(target => { try { return new URL(target.url); } catch { return undefined; } })
        .find(url => url?.origin === base.origin && !signInPage(url.pathname.slice(base.pathname.replace(/\/$/, '').length)));
      const session = page && cookieFor(cookies, page);
      if (page && page.pathname !== lastPage) { lastPage = page.pathname; log(`Sign-in browser is on ${page.pathname}${session ? '' : ' without an Overleaf session cookie'}.`); }
      // Validate a (cookie, page) pair only after Overleaf left its sign-in pages, and
      // check one that was not accepted again after a while, not on every poll.
      const key = session && `${session.value}\0${page.pathname}`;
      if (key && Date.now() - (tried.get(key) ?? -Infinity) >= (options.retryMs ?? 15_000)) {
        tried.set(key, Date.now());
        if (await options.validate(session.value)) return session.value;
        log(`Overleaf did not accept the session on ${page.pathname} yet; checking again in ${Math.round((options.retryMs ?? 15_000) / 1000)} s.`);
      }
      await pause(options.pollMs ?? 1000);
    }
  } finally {
    // Wait for an orderly exit: the browser writes the profile's cookies while
    // shutting down, which keeps a later sign-in to one click. A browser that never
    // answered on the pipe would ignore Browser.close, so it gets SIGTERM at once.
    if (!exited) {
      if (pipe.answered) void pipe.send('Browser.close').catch(() => {}); else child.kill();
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([closed, new Promise(resolve => { timer = setTimeout(resolve, 5000); })]);
      clearTimeout(timer);
      if (!exited) child.kill();
    }
  }
}
