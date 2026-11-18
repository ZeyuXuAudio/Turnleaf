import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { browserSignIn, findBrowser, browserCandidates } from '../src/core/browserSignIn';

// A scripted stand-in for Chrome's DevTools pipe (fd 3 in, fd 4 out).
function fakeBrowser(pages: { url: string; cookie?: string }[]) {
  const toBrowser = new PassThrough(), fromBrowser = new PassThrough(), child = new EventEmitter() as ChildProcess & EventEmitter;
  let step = 0, buffer = '';
  const calls: string[] = [];
  Object.assign(child, { stdio: [null, null, null, toBrowser, fromBrowser], exitCode: null, kill: () => { (child as any).exitCode = 1; child.emit('exit', 1); return true; } });
  toBrowser.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    for (let end = buffer.indexOf('\0'); end >= 0; end = buffer.indexOf('\0')) {
      const { id, method } = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); calls.push(method);
      const page = pages[Math.min(step, pages.length - 1)];
      const result = method === 'Storage.getCookies' ? { cookies: page.cookie ? [{ name: 'overleaf_session2', value: page.cookie, domain: '.overleaf.test', path: '/' }, { name: 'other', value: 'x', domain: '.overleaf.test', path: '/' }] : [] }
        : method === 'Target.getTargets' ? (step++, { targetInfos: [{ type: 'page', url: page.url }, { type: 'service_worker', url: 'https://www.overleaf.test/sw.js' }] })
        : {};
      fromBrowser.write(JSON.stringify({ id, result }) + '\0');
      if (method === 'Browser.close') setImmediate(() => child.kill());
    }
  });
  return { child, calls };
}
const base = { baseUrl: 'https://www.overleaf.test', executable: '/fake/chrome', pollMs: 5 };

test('browser sign-in validates only a session seen after Overleaf leaves its sign-in pages', async () => {
  const profileDir = await mkdtemp(join(tmpdir(), 'turnleaf-signin-'));
  const browser = fakeBrowser([
    { url: 'https://www.overleaf.test/login', cookie: 'anonymous' },
    { url: 'https://accounts.example/sso', cookie: 'anonymous' },
    { url: 'https://www.overleaf.test/project', cookie: 'expired' },
    { url: 'https://www.overleaf.test/project', cookie: 'expired' },
    { url: 'https://www.overleaf.test/project', cookie: 'signed-in' },
  ]);
  const tried: string[] = [];
  try {
    const cookie = await browserSignIn({ ...base, profileDir, launch: () => browser.child, validate: async value => { tried.push(value); return value === 'signed-in'; } });
    assert.equal(cookie, 'signed-in');
    assert.deepEqual(tried, ['expired', 'signed-in'], 'Anonymous sign-in-page sessions are never validated; each candidate is tried once');
    assert.equal(browser.calls.at(-1), 'Browser.close', 'The sign-in window is closed after success');
  } finally { await rm(profileDir, { recursive: true, force: true }); }
});

test('browser sign-in stops when the window is closed or the operation is cancelled', async () => {
  const profileDir = await mkdtemp(join(tmpdir(), 'turnleaf-signin-'));
  try {
    const closed = fakeBrowser([{ url: 'https://www.overleaf.test/login' }]);
    setTimeout(() => closed.child.kill(), 30);
    await assert.rejects(browserSignIn({ ...base, profileDir, launch: () => closed.child, validate: async () => true }), /closed before signing in/);
    const cancelled = fakeBrowser([{ url: 'https://www.overleaf.test/login' }]), abort = new AbortController();
    setTimeout(() => abort.abort(), 30);
    await assert.rejects(browserSignIn({ ...base, profileDir, signal: abort.signal, launch: () => cancelled.child, validate: async () => true }), /cancelled/);
    assert.equal(cancelled.calls.at(-1), 'Browser.close');
    const slow = fakeBrowser([{ url: 'https://www.overleaf.test/login' }]);
    await assert.rejects(browserSignIn({ ...base, profileDir, timeoutMs: 40, launch: () => slow.child, validate: async () => true }), /timed out/);
  } finally { await rm(profileDir, { recursive: true, force: true }); }
});

test('browser detection honours a configured path and platform install locations', () => {
  assert.equal(findBrowser('/custom/chrome', [], path => path === '/custom/chrome'), '/custom/chrome');
  assert.equal(findBrowser('/missing/chrome', ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'], path => path !== '/missing/chrome'), undefined, 'A wrong configured path is reported, not silently replaced');
  assert(browserCandidates('darwin', { HOME: '/Users/me' }).includes('/Users/me/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'));
  assert(browserCandidates('win32', { PROGRAMFILES: 'C:\\Program Files' }).includes('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'));
  assert(browserCandidates('linux', { PATH: '/usr/bin:/snap/bin' }).includes('/snap/bin/chromium'));
});

const chrome = findBrowser();
test('a real Chromium browser signs in once and reuses its private profile', { skip: !chrome && 'No Chromium-based browser installed' }, async () => {
  const sessions = { anonymous: 0, signedIn: 0 };
  const server = createServer((req, res) => {
    const cookie = /overleaf_session2=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    if (req.url === '/login' && req.method === 'GET') {
      if (cookie === 'signed-in') { res.writeHead(302, { Location: '/project' }).end(); return; }
      sessions.anonymous++;
      // Stands in for the user typing a password and pressing Log in. Like Overleaf's,
      // the signed-in cookie has an expiry, so the private profile keeps it.
      res.writeHead(200, { 'Set-Cookie': 'overleaf_session2=anonymous; Path=/; HttpOnly', 'Content-Type': 'text/html' }).end('<form id="f" method="post" action="/login"></form><script>setTimeout(() => f.submit(), 200)</script>');
    } else if (req.url === '/login' && req.method === 'POST') {
      sessions.signedIn++;
      res.writeHead(302, { 'Set-Cookie': 'overleaf_session2=signed-in; Path=/; HttpOnly; Max-Age=3600', Location: '/project' }).end();
    } else res.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>Projects</title>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const profileDir = await mkdtemp(join(tmpdir(), 'turnleaf-chrome-'));
  try {
    const options = { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, executable: chrome!, profileDir, headless: true, pollMs: 100, timeoutMs: 30_000 };
    const tried: string[] = [];
    assert.equal(await browserSignIn({ ...options, validate: async value => { tried.push(value); return value === 'signed-in'; } }), 'signed-in');
    assert(!tried.includes('anonymous'));
    assert.equal(await browserSignIn({ ...options, validate: async value => value === 'signed-in' }), 'signed-in');
    assert.deepEqual(sessions, { anonymous: 1, signedIn: 1 }, 'The second sign-in reused the profile without a new login');
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
