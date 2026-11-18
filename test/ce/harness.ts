// Node side of scripts/ce.mjs: scripted admin, login and seeding against a throwaway
// Overleaf Community Edition instance, a threads shim, and an editor-free inspection.
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OverleafReader } from '../../src/core/overleaf';
import { summarizeError, summarizeInspection, summarizeJoinProject } from '../../src/core/probe';
import { checkInspection, Expectations } from './check';
import { CeError, CeSession, CeSocket } from './client';
import { planProject, type OtType } from './seed';

export const SESSION_COOKIE = 'overleaf_session2';
export type { OtType } from './seed';
export interface SeededProject { label: OtType; projectId: string; expectations: Expectations; }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Thread messages and the history-ot switch are not reachable through CE's public web
 * routes: comments are a Server Pro feature, so CE has no thread routes, and nothing public
 * sets a project's OT migration stage. scripts/ce.mjs supplies a backend that reaches the
 * internal chat service, document updater and MongoDB with `docker compose exec`.
 */
export interface Backend {
  name: string;
  postMessage(projectId: string, threadId: string, userId: string, content: string): Promise<void>;
  resolveThread(projectId: string, docId: string, threadId: string, userId: string): Promise<void>;
  /** The raw `GET /project/:id/threads` JSON, for the threads shim. */
  threads?(projectId: string): Promise<string>;
  /** Moves a project with no connected clients to history-ot (otMigrationStage 1). */
  migrateToHistoryOT?(projectId: string): Promise<void>;
}

/** Server Pro and overleaf.com routes, for OVERLEAF_CE_URL instances that have them. */
export function webBackend(session: CeSession): Backend {
  return {
    name: 'web routes',
    postMessage: async (projectId, threadId, _userId, content) => { await session.ok(`/project/${projectId}/thread/${threadId}/messages`, { json: { content } }); },
    resolveThread: async (projectId, docId, threadId) => { await session.ok(`/project/${projectId}/doc/${docId}/thread/${threadId}/resolve`, { json: {} }); },
  };
}

export async function waitForServer(baseUrl: string, timeoutMs: number): Promise<number> {
  const started = Date.now(), deadline = started + timeoutMs;
  let last = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await new CeSession(baseUrl).request('/login', { accept: 'text/html' });
      if (response.status === 200) return Date.now() - started;
      last = `HTTP ${response.status}`;
    } catch (error) { last = error instanceof Error ? error.message : String(error); }
    await sleep(2_000);
  }
  throw new CeError(`Overleaf did not serve /login within ${Math.round(timeoutMs / 1000)} s (${last}).`);
}

/** Registers the first admin through the launchpad of a fresh instance. */
export async function ensureAdmin(baseUrl: string, email: string, password: string): Promise<'registered' | 'exists'> {
  const session = new CeSession(baseUrl);
  const page = await session.request('/launchpad', { accept: 'text/html', follow: false });
  // Once an admin exists, the launchpad needs an admin login, so it redirects to /login.
  if (page.status !== 200 || session.meta(page.body, 'ol-adminUserExists') === 'true') return 'exists';
  session.csrfToken = session.meta(page.body, 'ol-csrfToken');
  if (!session.csrfToken) throw new CeError('No CSRF token on /launchpad.');
  const response = await session.request('/launchpad/register_admin', { json: { email, password } });
  if (response.status === 403) return 'exists';
  if (response.status !== 200) throw new CeError(`Admin registration returned HTTP ${response.status}: ${response.body.slice(0, 200)}`);
  return 'registered';
}

export async function login(baseUrl: string, email: string, password: string): Promise<{ session: CeSession; cookieNames: string[] }> {
  const session = new CeSession(baseUrl);
  await session.page('/login');
  const response = await session.request('/login', { json: { email, password } });
  let body: any = {};
  try { body = JSON.parse(response.body); } catch { /* reported below */ }
  const cookieNames = [...session.cookies.keys()].sort();
  if (response.status !== 200 || body.message?.type === 'error') {
    throw new CeError(`Login failed: HTTP ${response.status}${body.message?.text ? `: ${body.message.text}` : ''}.`);
  }
  if (!session.cookies.get(SESSION_COOKIE)) {
    throw new CeError(`Login set the cookies ${cookieNames.join(', ') || '(none)'} but not ${SESSION_COOKIE}, the only cookie the extension sends. Set COOKIE_NAME=${SESSION_COOKIE} on the Overleaf container.`);
  }
  // The extension receives this one cookie; check it is accepted on its own.
  const alone = new CeSession(baseUrl);
  alone.cookies.set(SESSION_COOKIE, session.cookies.get(SESSION_COOKIE)!);
  const page = await alone.request('/project', { accept: 'text/html' });
  if (page.status !== 200 || !alone.meta(page.body, 'ol-csrfToken')) throw new CeError(`The ${SESSION_COOKIE} cookie alone was not accepted by /project (HTTP ${page.status}).`);
  return { session, cookieNames };
}

export function sessionCookie(session: CeSession): string { return session.cookies.get(SESSION_COOKIE)!; }

export async function serverInfo(session: CeSession): Promise<{ userId: string; appName?: string; projectListMeta: string[] }> {
  const html = await session.page('/project');
  const userId = session.meta(html, 'ol-user_id');
  if (!userId || !/^[0-9a-f]{24}$/.test(userId)) throw new CeError('/project has no ol-user_id meta tag.');
  let appName: string | undefined;
  try { appName = JSON.parse(session.meta(html, 'ol-ExposedSettings') ?? '{}').appName; } catch { /* optional */ }
  return { userId, appName, projectListMeta: ['ol-prefetchedProjectsBlob', 'ol-projects'].filter(name => session.meta(html, name) !== undefined) };
}

const joinOptions = { encodeRanges: true, supportsHistoryOT: true };
const docReply = (reply: unknown[]) => ({ version: reply[1] as number, otType: String(reply[4] ?? 'sharejs-text-ot') });

/**
 * Creates a project with the planned files and, for history-ot, switches it before any
 * editor connects; then seeds threads and tracked changes as the admin.
 */
export async function seedProject(session: CeSession, backend: Backend, userId: string, otType: OtType, onCreated: (projectId: string) => void) {
  const plan = planProject();
  await session.page('/project');
  const name = `Turnleaf CE test ${otType} ${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const { project_id: projectId } = await session.json<{ project_id: string }>('/project/new', { json: { projectName: name, template: 'none' } });
  if (!/^[0-9a-f]{24}$/.test(projectId ?? '')) throw new CeError('/project/new returned no project id.');
  // Register cleanup before any socket, upload or seeding operation can fail.
  onCreated(projectId);

  let socket = new CeSocket(session, projectId);
  const rootFolderId: string | undefined = (await socket.open()).project?.rootFolder?.[0]?._id;
  await socket.close();
  if (!rootFolderId) throw new CeError('joinProject returned no root folder id.');
  for (const doc of plan.docs) {
    const form = new FormData();
    form.append('name', doc.path);
    form.append('qqfile', new Blob([doc.initialText], { type: 'application/octet-stream' }), doc.path);
    const upload = await session.json<{ success?: boolean; entity_type?: string }>(`/project/${projectId}/upload?folder_id=${rootFolderId}`, { form });
    if (upload.success === false || (upload.entity_type && upload.entity_type !== 'doc')) throw new CeError(`Upload of ${doc.path} did not create a text document.`);
  }
  if (otType === 'history-ot') {
    if (!backend.migrateToHistoryOT) throw new CeError(`The ${backend.name} backend cannot switch a project to history-ot.`);
    await backend.migrateToHistoryOT(projectId);
  }

  socket = new CeSocket(session, projectId);
  const project = await socket.open();
  const joinProject = summarizeJoinProject(socket.joinProjectResponse);
  const docIds = new Map<string, string>(((project.project?.rootFolder?.[0]?.docs ?? []) as { _id: string; name: string }[]).map(doc => [doc.name, doc._id]));
  const otTypes: Record<string, { before: string; after?: string }> = {};
  try {
    for (const doc of plan.docs) {
      const docId = docIds.get(doc.path);
      if (!docId) throw new CeError(`${doc.path} is not a text document after upload.`);
      let { version, otType: served } = docReply(await socket.emit('joinDoc', docId, joinOptions));
      otTypes[doc.path] = { before: served };
      if (served !== otType) throw new CeError(`${doc.path} was served as ${served}, expected ${otType}.`);
      for (const edit of doc.operations(otType, userId, new Date().toISOString())) {
        const thread = doc.threads.find(thread => thread.threadId === edit.threadId);
        if (thread) await backend.postMessage(projectId, thread.threadId, userId, thread.message);
        // sharejs-text-ot: meta.tc (18 hex characters) makes the document updater track the edit.
        const update = otType === 'history-ot' ? { doc: docId, op: [edit.op], v: version }
          : { doc: docId, op: [edit.op], v: version, ...edit.tracked && { meta: { tc: hex(9) } } };
        await socket.emit('applyOtUpdate', docId, update);
        version++;
        if (thread?.resolved) {
          await backend.resolveThread(projectId, docId, thread.threadId, userId);
          if (otType === 'history-ot') { await socket.emit('applyOtUpdate', docId, { doc: docId, op: [{ commentId: thread.threadId, resolved: true }], v: version }); version++; }
        }
      }
      await socket.emit('leaveDoc', docId);
      otTypes[doc.path].after = docReply(await socket.emit('joinDoc', docId, joinOptions)).otType;
      await socket.emit('leaveDoc', docId);
    }
  } finally { await socket.close(); }
  for (const thread of plan.unassignedThreads) await backend.postMessage(projectId, thread.threadId, userId, thread.message);
  const expectations: Expectations = { docs: plan.docs.map(doc => doc.expected(otType)), unassignedThreads: plan.unassignedThreads.length };
  return { project: { label: otType, projectId, expectations } as SeededProject, otTypes, joinProject };
}

const hex = (bytes: number) => [...crypto.getRandomValues(new Uint8Array(bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');

export function seedSummary(expectations: Expectations) {
  return {
    docs: expectations.docs.map(doc => ({
      path: doc.path, threads: doc.anchors.length, resolved: doc.anchors.filter(anchor => anchor.resolved).length,
      anchors: Object.fromEntries(['placed', 'hidden', 'anchor removed'].map(state => [state, doc.anchors.filter(anchor => anchor.state === state).length])),
      multipleRangeAnchors: doc.anchors.filter(anchor => anchor.ranges.length > 1).length,
      rawRangeChecks: doc.anchors.filter(anchor => anchor.rawRanges !== undefined).length,
      suggestions: { insert: doc.suggestions.filter(s => s.kind === 'insert').length, delete: doc.suggestions.filter(s => s.kind === 'delete').length },
    })),
    unassignedThreads: expectations.unassignedThreads,
  };
}

export function planSummary(otType: OtType) {
  const plan = planProject();
  return seedSummary({ docs: plan.docs.map(doc => doc.expected(otType)), unassignedThreads: plan.unassignedThreads.length });
}

/** The status of the extension's thread read on the real server (404 means the route is absent). */
export async function threadsStatus(session: CeSession, projectId: string): Promise<number> {
  return (await session.request(`/project/${projectId}/threads`)).status;
}

export async function deleteProject(session: CeSession, projectId: string): Promise<void> {
  await session.page('/project');
  await session.ok(`/project/${projectId}`, { method: 'DELETE' });
}

/**
 * A loopback proxy in front of CE that adds the Server Pro `GET /project/:id/threads` route,
 * answered from the chat service after CE confirms the caller's session can read the project.
 * Everything else, including the Socket.IO polling, is passed through unchanged.
 */
export async function startThreadsShim(baseUrl: string, backend: Backend): Promise<{ url: string; served: number; close(): Promise<void> }> {
  const target = new URL(baseUrl);
  const state = { served: 0 };
  const server = createServer(async (req, res) => {
    const match = req.method === 'GET' ? /^\/project\/([0-9a-f]{24})\/threads$/.exec(req.url ?? '') : null;
    if (match && backend.threads) {
      try {
        const check = new CeSession(baseUrl);
        const cookie = /(?:^|;\s*)overleaf_session2=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
        if (cookie) check.cookies.set(SESSION_COOKIE, cookie);
        const allowed = cookie ? (await check.request(`/project/${match[1]}/entities`, { follow: false })).status : 401;
        if (allowed !== 200) { res.writeHead(allowed === 401 ? 302 : allowed, allowed === 401 ? { Location: '/login' } : {}).end(); return; }
        const body = await backend.threads(match[1]);
        state.served++;
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(body);
      } catch { res.writeHead(502).end(); }
      return;
    }
    const upstream = httpRequest({ host: target.hostname, port: target.port || 80, method: req.method, path: req.url, headers: { ...req.headers, host: target.host } }, response => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    get served() { return state.served; },
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

/** --no-editor: the extension's reader and summaries, without the editor host. */
export async function inspectWithReader(baseUrl: string, cookie: string, projects: SeededProject[]) {
  const reader = new OverleafReader(baseUrl, cookie);
  const errors: { step: string; code: string; status?: number; message: string }[] = [];
  let accepted = false;
  try { await reader.signIn(); accepted = true; } catch (error) { errors.push({ step: 'signIn', ...summarizeError(error) }); }
  const results = [];
  for (const project of accepted ? projects : []) {
    const started = Date.now();
    let inspection, error;
    try { inspection = await reader.inspect(project.projectId, project.expectations.docs.map(doc => doc.path)); }
    catch (caught) { error = { step: `inspect ${project.label}`, ...summarizeError(caught) }; errors.push(error); }
    results.push({ label: project.label, inspect: { durationMs: Date.now() - started, error: error ?? null },
      inspection: inspection ? summarizeInspection(inspection) : null, positionProblems: inspection ? checkInspection(inspection, project.expectations) : [] });
  }
  return { runtime: { mode: 'node (--no-editor)', node: process.versions.node }, session: { accepted }, projects: results, errors };
}

export function otTypeNote(observed: string[]): string {
  const types = new Set(observed);
  if (!types.size) return 'No document was read, so the OT type is unknown.';
  const list = [...types].sort().join(' and ');
  return types.has('history-ot')
    ? `Community Edition served ${list}. By default CE serves sharejs-text-ot, as overleaf.com did on 2026-10-20; history-ot appears only after the harness raises the project's otMigrationStage.`
    : `Community Edition served only ${list}, as overleaf.com did on 2026-10-20; history-ot was not exercised.`;
}
