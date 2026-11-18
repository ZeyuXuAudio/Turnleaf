// Project/session parsing and socket reads adapted from olcli v0.14.0 (MIT).
import { Parser } from 'htmlparser2';
import { ReadTransport } from './http';
import { ReadSocket } from './socket';
import { array, normalizeDoc, object, validateTrackedFiles } from './docState';
import { Inspection, Project, ProjectTree, RemoteFile, Thread } from './models';
import { contentType, defaultUploadLimit, gitBlobSha1, isPicture, validHash } from './pictures';
import { protocolError, SessionExpiredError, SyncError } from './errors';
import type { ReadObserver } from './probe';
import { randomUUID } from 'node:crypto';
import { WritePermit, requirePermit, validateUpload } from './guard';
import { DocState } from './models';
import { progress } from './operation';
import { diffText } from './diff';
import { historyTextOp, shareJsOp, trackedChangeSeed } from './textOps';
import { findSuggestion, historyDecisionOp, shareJsRejectOp } from './suggestions';

function metaTags(html: string): Map<string, string> {
  const tags = new Map<string, string>();
  let login = false;
  let inScript = false;
  const parser = new Parser({ onopentag(name, attrs) {
    inScript = name === 'script';
    if (name === 'meta' && attrs.name && attrs.content !== undefined) tags.set(attrs.name, attrs.content);
    if (name === 'form' && (/\/login\/?$/.test(attrs.action ?? '') || attrs.name === 'loginForm')) login = true;
    if (name === 'input' && attrs.name === 'password') login = true;
    if (name === 'input' && attrs.name === '_csrf' && attrs.value) tags.set('_csrf', attrs.value);
  }, onclosetag(name) { if (name === 'script') inScript = false; }, ontext(text) {
    if (inScript) {
      const csrf = /csrfToken["']?\s*[:=]\s*["']([^"']+)["']/.exec(text);
      if (csrf) tags.set('_csrf', csrf[1]);
    }
  } }, { decodeEntities: true });
  parser.end(html);
  if (login) throw new SessionExpiredError();
  return tags;
}

export function parseProjects(html: string): Project[] {
  const tags = metaTags(html);
  for (const name of ['ol-prefetchedProjectsBlob', 'ol-projects', ...tags.keys()]) {
    const value = tags.get(name);
    if (!value) continue;
    let data: unknown;
    try { data = JSON.parse(value); } catch { continue; }
    const projects = Array.isArray(data) && ['ol-prefetchedProjectsBlob', 'ol-projects'].includes(name) ? data : (data as { projects?: unknown })?.projects;
    if (!Array.isArray(projects)) continue;
    return projects.filter(p => !p.archived && !p.trashed).map(p => {
      if (typeof (p.id ?? p._id) !== 'string' || typeof p.name !== 'string') protocolError();
      return { id: p.id ?? p._id, name: p.name, lastUpdated: p.lastUpdated };
    });
  }
  return protocolError();
}

export function normalizeThreads(value: unknown): Record<string, Thread> {
  const result: Record<string, Thread> = Object.create(null);
  for (const [id, item] of Object.entries(object(value))) {
    const thread = object(item);
    result[id] = { id, resolved: Boolean(thread.resolved), messages: array(thread.messages).map(value => {
      const message = object(value), user = object(message.user ?? {});
      if (typeof message.content !== 'string') protocolError();
      const authorId = user.id ?? user._id ?? message.user_id;
      return { id: message.id, text: message.content, timestamp: message.timestamp, ...(typeof authorId === 'string' ? { authorId } : {}),
        author: user.name || [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email || message.user_id || 'Unknown author' };
    }) };
  }
  return result;
}

interface Tree { docs: Map<string, { id: string; folderId?: string }>; folders: Record<string, string>; files: string[]; fileRefs: Record<string, RemoteFile>; }
/**
 * Text documents with their folder, folder IDs by path ('' is the root folder), and
 * the other files from a joinProject tree: each with its file ID, content hash (the
 * Git blob SHA-1) and whether it is linked (a non-null `linkedFileData`).
 */
function walkTree(project: Record<string, any>): Tree {
  const tree: Tree = { docs: new Map(), folders: {}, files: [], fileRefs: Object.create(null) };
  const walk = (value: unknown, path: string) => {
    const folder = object(value), prefix = path ? path + '/' : '';
    if (typeof folder._id === 'string') tree.folders[path] = folder._id;
    for (const entry of array(folder.docs)) {
      if (typeof entry._id !== 'string' || typeof entry.name !== 'string') protocolError();
      if (tree.docs.has(prefix + entry.name)) protocolError();
      tree.docs.set(prefix + entry.name, { id: entry._id, folderId: folder._id });
    }
    for (const entry of array(folder.fileRefs)) {
      if (typeof entry?.name !== 'string') continue;
      tree.files.push(prefix + entry.name);
      if (typeof entry._id === 'string') tree.fileRefs[prefix + entry.name] = { id: entry._id, ...validHash(entry.hash) && { hash: entry.hash }, linked: entry.linkedFileData !== null && entry.linkedFileData !== undefined, ...typeof folder._id === 'string' && { folderId: folder._id } };
    }
    for (const child of array(folder.folders)) {
      if (typeof child.name !== 'string') protocolError();
      walk(child, prefix + child.name);
    }
  };
  for (const root of array(project.rootFolder)) walk(root, '');
  return tree;
}
const objectId = /^[0-9a-f]{24}$/i;

export class OverleafReader {
  private readonly transport: ReadTransport;
  private csrf = '';
  private userId?: string;
  private uploadLimit?: number;
  constructor(baseUrl: string, cookie: string, private readonly observer?: ReadObserver) { this.transport = new ReadTransport(baseUrl, cookie); }
  get sessionCookie(): string { return this.transport.sessionCookie; }

  private async bootstrap(): Promise<void> {
    try {
      const tags = metaTags(await this.transport.get(this.transport.url('/project')));
      if (!['ol-csrfToken', 'csrf-token', '_csrf'].some(name => tags.has(name))) throw new SessionExpiredError();
      this.csrf = tags.get('ol-csrfToken') ?? tags.get('csrf-token') ?? tags.get('_csrf')!;
      this.userId = tags.get('ol-user_id');
      try { const limit = JSON.parse(tags.get('ol-ExposedSettings') ?? '{}')?.maxUploadSize; if (Number.isSafeInteger(limit) && limit > 0) this.uploadLimit = limit; } catch { /* optional */ }
    } catch (error) {
      if (error instanceof SyncError && error.status === 403) throw new SessionExpiredError();
      throw error;
    }
  }
  /** How long a read waits before it opens the project again after Overleaf's per-minute limit on opening it. */
  rateLimitWaitMs = 20_000;
  /**
   * Reads open the project once each, and Overleaf refuses more than 45 opens of a
   * project a minute (`join-project` on Community Edition). A refused read wrote
   * nothing, so it waits and opens again, for at most about a minute.
   */
  private async joined<T>(action: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try { return await this.withSession(action); }
      catch (error) {
        if (!(error instanceof SyncError) || error.code !== 'rate-limit' || attempt >= 3) throw error;
        progress('Overleaf limits how often a project is opened per minute; waiting before reading again…');
        await new Promise(resolve => setTimeout(resolve, this.rateLimitWaitMs));
      }
    }
  }
  private async withSession<T>(action: () => Promise<T>): Promise<T> {
    try { return await action(); }
    catch (error) {
      if (!(error instanceof SyncError) || error.status !== 403) throw error;
      await this.bootstrap();
      try { return await action(); }
      catch (retryError) {
        if (retryError instanceof SyncError && retryError.status === 403) throw new SessionExpiredError();
        throw retryError;
      }
    }
  }
  async signIn(): Promise<Project[]> {
    await this.bootstrap();
    return this.listProjects();
  }
  async listProjects(): Promise<Project[]> {
    return this.withSession(async () => {
      const html = await this.transport.get(this.transport.url('/project'));
      const projects = parseProjects(html);
      if (this.observer?.projectPage) this.observer.projectPage(metaTags(html));
      return projects;
    });
  }
  async inspect(projectId: string, configuredPaths: string[]): Promise<Inspection> {
    const session = await this.openSession(projectId, configuredPaths);
    try { return session.inspection; } finally { await session.close(); }
  }
  /** The project's text documents, and its main document (the one Overleaf compiles) when it has one. */
  async listSourceFiles(projectId: string): Promise<{ paths: string[]; rootDoc?: string }> {
    if (!projectId) throw new SyncError('Choose an Overleaf project first.', 'configuration');
    return this.joined(async () => {
      if (!this.csrf) await this.bootstrap();
      const socket = new ReadSocket(this.transport, projectId, this.observer);
      try {
        const project = object(await socket.open()), paths: string[] = [];
        let rootDoc: string | undefined;
        const walk = (value: unknown, parent: string) => {
          const folder = object(value);
          for (const doc of array(folder.docs)) if (typeof doc.name === 'string') {
            paths.push(parent + doc.name);
            if (typeof project.rootDoc_id === 'string' && doc._id === project.rootDoc_id) rootDoc = parent + doc.name;
          }
          for (const child of array(folder.folders)) if (typeof child.name === 'string') walk(child, parent + child.name + '/');
        };
        for (const folder of array(project.rootFolder)) walk(folder, '');
        return { paths: paths.sort(), ...rootDoc && { rootDoc } };
      } finally { await socket.close(); }
    });
  }
  /** A fresh read of the project tree over its own short connection: document and folder IDs by path, and other files. */
  async projectTree(projectId: string): Promise<ProjectTree> {
    return this.joined(async () => {
      if (!this.csrf) await this.bootstrap();
      const socket = new ReadSocket(this.transport, projectId, this.observer);
      try {
        const tree = walkTree(object(await socket.open()));
        return { folders: tree.folders, docs: Object.fromEntries([...tree.docs].map(([path, entry]) => [path, entry.id])), files: tree.files, fileRefs: tree.fileRefs };
      } finally { await socket.close(); }
    });
  }
  /**
   * The bytes of a non-text file, by content hash with the file ID as fallback
   * (`/blob/:hash?fallback=:fileId`), then by file ID (`/file/:fileId`). The bytes
   * must hash to `file.hash`, the Git blob SHA-1 from the project tree, or the read fails.
   */
  async downloadFile(projectId: string, path: string, file: { id: string; hash: string }, limit = defaultUploadLimit): Promise<Buffer> {
    if (!validHash(file.hash) || !objectId.test(file.id)) throw new SyncError(`${path}: Overleaf gave no usable file ID or hash.`, 'download');
    const p = encodeURIComponent(projectId), options = { timeoutMs: 120_000 }, cap = limit + 1024 * 1024;
    return this.withSession(async () => {
      if (!this.csrf) await this.bootstrap();
      let bytes: Buffer;
      try { bytes = await this.transport.download(this.transport.url(`/project/${p}/blob/${file.hash}?fallback=${encodeURIComponent(file.id)}`), cap, options); }
      catch (error) {
        if (error instanceof SyncError && (error.code === 'cancelled' || error instanceof SessionExpiredError)) throw error;
        bytes = await this.transport.download(this.transport.url(`/project/${p}/file/${encodeURIComponent(file.id)}`), cap, options);
      }
      if (gitBlobSha1(bytes) !== file.hash) throw new SyncError(`${path}: the downloaded bytes do not match Overleaf's hash. Get latest again.`, 'download');
      return bytes;
    });
  }
  private async readThreads(projectId: string): Promise<Record<string, Thread>> {
    return normalizeThreads(JSON.parse(await this.transport.get(this.transport.url(`/project/${encodeURIComponent(projectId)}/threads`))));
  }
  /**
   * Opens the project's realtime session. With `live`, tracked files stay joined
   * after the first read, so the server keeps sending their edits and the
   * session can be refreshed without a new connection.
   */
  async openSession(projectId: string, configuredPaths: string[], options: { live?: boolean } = {}): Promise<RemoteSession> {
    progress('Reading project and comments…');
    const paths = validateTrackedFiles(configuredPaths);
    if (!projectId) throw new SyncError('Link an Overleaf project first.', 'configuration');
    return this.joined(async () => {
      if (!this.csrf) await this.bootstrap();
      let threads = await this.readThreads(projectId);
      const socket = new ReadSocket(this.transport, projectId, this.observer);
      try {
        const project = object(await socket.open());
        const walked = walkTree(project), docs = walked.docs;
        let tree: ProjectTree = { folders: walked.folders, files: walked.files, fileRefs: walked.fileRefs };
        const tracking = project.trackChangesState;
        const trackChanges = typeof tracking === 'boolean' ? tracking : tracking && this.userId ? tracking[this.userId] === true : undefined;
        const authors = new Map<string, string>();
        for (const value of [project.owner, ...array(project.collaberators ?? []), ...array(project.collaborators ?? []), ...array(project.members ?? [])]) {
          const user = value?.user ?? value;
          const id = user?.id ?? user?._id, name = user?.name || [user?.first_name, user?.last_name].filter(Boolean).join(' ') || user?.email;
          if (typeof id === 'string' && typeof name === 'string' && name.trim()) authors.set(id, name);
        }
        // Comment responses include names even when joinProject omits members
        // (including reviewers who have since left the project).
        const rememberCommentAuthors = () => {
          for (const thread of Object.values(threads)) for (const message of thread.messages) {
            if (message.authorId && message.author !== message.authorId && message.author !== 'Unknown author') authors.set(message.authorId, message.author);
          }
        };
        rememberCommentAuthors();
        const named = (doc: DocState): DocState => ({ ...doc, changes: doc.changes.map(change => ({ ...change,
          author: authors.get(change.authorId ?? change.author) ?? 'Unknown author' })) });
        const read = async (path: string, entry: { id: string; folderId?: string }) => {
          const doc = normalizeDoc(path, entry.id, await socket.join(entry.id));
          doc.folderId = entry.folderId;
          return named(doc);
        };
        const assemble = (current: DocState[]): Inspection => {
          rememberCommentAuthors();
          const placed = new Set(current.flatMap(doc => doc.comments.map(comment => comment.threadId)));
          return { projectId, projectName: String(project.name ?? projectId), fetchedAt: new Date().toISOString(), docs: current.map(named), threads, userId: this.userId, trackChanges,
            missingFiles: paths.filter(path => !docs.has(path)), unassignedThreadCount: Object.keys(threads).filter(id => !placed.has(id)).length, tree,
            ...this.uploadLimit && { maxUploadSize: this.uploadLimit } };
        };
        const current: DocState[] = [];
        for (const path of paths) {
          progress(`Reading ${path}…`);
          const entry = docs.get(path);
          if (!entry) continue;
          current.push(await read(path, entry));
          if (!options.live) await socket.leave(entry.id);
        }
        let inspection = assemble(current), queue: Promise<unknown> = Promise.resolve();
        const rejoin = async (doc: DocState) => { await socket.leave(doc.docId); return read(doc.path, { id: doc.docId, folderId: docs.get(doc.path)?.folderId }); };
        // Serialised with refresh, like every leave/join of this connection.
        const serial = <T>(step: () => Promise<T>): Promise<T> => { const run = queue.then(step); queue = run.catch(() => {}); return run; };
        const adopt = (next?: ProjectTree) => { if (next) tree = { folders: next.folders, files: next.files, fileRefs: next.fileRefs }; };
        return { get inspection() { return inspection; }, socket, rejoin,
          track: (path, docId, folderId, next) => serial(async () => {
            if (!paths.includes(path)) throw new SyncError(`${path} is not a selected file.`, 'configuration');
            adopt(next); docs.set(path, { id: docId, folderId });
            const doc = await read(path, { id: docId, folderId });
            inspection = assemble([...inspection.docs.filter(item => item.path !== path), doc]);
            return doc;
          }),
          untrack: (path, next) => serial(async () => {
            const doc = inspection.docs.find(item => item.path === path);
            if (doc) await socket.leave(doc.docId).catch(() => {});
            adopt(next); docs.delete(path);
            inspection = assemble(inspection.docs.filter(item => item.path !== path));
          }),
          // Serialised: a leave/join of one document must not interleave with another refresh.
          refresh: (scope = {}) => {
            const run = queue.then(async () => {
              if (scope.threads !== false) threads = await this.withSession(() => this.readThreads(projectId));
              const which = scope.docs ?? 'all';
              const next: DocState[] = [];
              for (const doc of inspection.docs) {
                const changed = which === 'all' || (which === 'changed' ? socket.updates.some(update => update.doc === doc.docId && update.v >= doc.version) : which.includes(doc.docId));
                next.push(changed ? await rejoin(doc) : doc);
              }
              inspection = assemble(next);
              return inspection;
            });
            queue = run.catch(() => {});
            return run;
          },
          close: () => socket.close() };
      } catch (error) { await socket.close(); throw error; }
    });
  }

  /** Sends one confirmed write. Returns the new ID for 'createDoc', 'createFolder' and 'uploadFile'. */
  async write(permit: WritePermit, live?: RemoteSession): Promise<string | void> {
    const action = requirePermit(permit), p = encodeURIComponent(action.projectId);
    if (!this.csrf) await this.bootstrap();
    if (action.kind === 'createThread') {
      const anchor = action.anchor;
      if (!anchor || !action.path || !action.docId || !action.threadId || !action.text?.trim()) throw new SyncError('The new comment draft is incomplete.', 'configuration');
      // Reuse an open live session; its document and comments are re-read first.
      const session = live ?? await this.openSession(action.projectId, [action.path]);
      if (live) await live.refresh({ docs: [action.docId] });
      try {
        let doc = session.inspection.docs.find(doc => doc.docId === action.docId);
        if (!doc || doc.text !== anchor.source || session.inspection.threads[action.threadId]) throw new SyncError('The source changed or this thread already exists. Review the new comment again.', 'stale');
        if (!Number.isSafeInteger(anchor.from) || !Number.isSafeInteger(anchor.to) || anchor.from < 0 || anchor.to <= anchor.from || anchor.to > doc.text.length) throw new SyncError('Select a non-empty comment range.', 'configuration');
        // Overleaf itself posts the first message before submitting the anchor.
        // The durable send journal must already contain this generated thread ID.
        await this.transport.postContent(this.transport.url(`/project/${p}/thread/${encodeURIComponent(action.threadId)}/messages`), JSON.stringify({ content: action.text }), 'application/json', this.csrf);
        doc = await session.rejoin(doc);
        if (doc.text !== anchor.source) throw new SyncError(`The source changed after the message was created. Thread ${action.threadId} needs verification; do not resend automatically.`, 'comment');
        await session.socket.attachComment(doc, action.threadId, anchor.from, anchor.to, this.csrf);
        const observed = await session.rejoin(doc), placed = observed.comments.find(comment => comment.threadId === action.threadId);
        if (!placed || placed.state !== 'placed' || placed.ranges.map(range => observed.text.slice(range.pos, range.pos + range.length)).join('') !== anchor.source.slice(anchor.from, anchor.to)) throw new SyncError(`The comment message was created but its anchor could not be verified. Review thread ${action.threadId} in sync history.`, 'comment');
      } finally { if (!live) await session.close(); }
      return;
    }
    if (action.kind === 'createDoc' || action.kind === 'createFolder') {
      if (!action.path || !action.folderId) throw new SyncError('Creating on Overleaf needs the path and its folder. Refresh first.', 'configuration');
      const name = action.path.split('/').at(-1)!;
      // The routes of Overleaf's file tree (New file, New folder). A name that
      // exists in the folder is refused, unlike an upload, which replaces it.
      const response = await this.transport.postContent(this.transport.url(`/project/${p}/${action.kind === 'createDoc' ? 'doc' : 'folder'}`), JSON.stringify({ name, parent_folder_id: action.folderId }), 'application/json', this.csrf);
      let data: any;
      try { data = JSON.parse(response); } catch { /* unclear below */ }
      if (typeof data?._id !== 'string' || !objectId.test(data._id) || (data.name !== undefined && data.name !== name)) throw new SyncError(`Overleaf gave an unclear answer to creating ${action.path}. Get latest to check what reached Overleaf before sending again.`, 'upload');
      return data._id;
    }
    if (action.kind === 'uploadFile') {
      // A picture through Overleaf's upload route. An existing file of that name is replaced
      // (with a new file ID); the caller has checked that the name is no text document or linked file.
      const path = action.path, bytes = action.bytes;
      if (!path || !bytes || !action.folderId || !isPicture(path) || !validHash(action.hash) || gitBlobSha1(bytes) !== action.hash) throw new SyncError('Uploading a picture needs its path, folder and checked bytes. Refresh first.', 'configuration');
      const name = path.split('/').at(-1)!;
      if (/["\r\n\\]/.test(name)) throw new SyncError('Unsupported upload filename.', 'configuration');
      const boundary = `turnleaf-${randomUUID()}`;
      const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\n${name}\r\n--${boundary}\r\nContent-Disposition: form-data; name="qqfile"; filename="${name}"\r\nContent-Type: ${contentType(path)}\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);
      const response = await this.transport.postContent(this.transport.url(`/project/${p}/upload?folder_id=${encodeURIComponent(action.folderId)}`), body, `multipart/form-data; boundary=${boundary}`, this.csrf, { timeoutMs: 120_000, accept: 'application/json' });
      let data: any;
      try { data = JSON.parse(response); } catch { /* unclear below */ }
      if (data?.success !== true || data.entity_type !== 'file' || typeof data.entity_id !== 'string' || !objectId.test(data.entity_id) || data.hash !== action.hash) throw new SyncError(`Overleaf gave an unclear answer to uploading ${path}. Get latest to check what reached Overleaf before sending again.`, 'upload');
      return data.entity_id;
    }
    if (action.kind === 'deleteFile') {
      if (!action.fileId || !objectId.test(action.fileId)) throw new SyncError('Deleting a file on Overleaf needs its file ID. Refresh first.', 'configuration');
      // Overleaf keeps the deleted bytes downloadable by hash and restorable in its history.
      await this.transport.deleteContent(this.transport.url(`/project/${p}/file/${encodeURIComponent(action.fileId)}`), this.csrf);
      return;
    }
    if (action.kind === 'deleteDoc') {
      if (!action.docId) throw new SyncError('Deleting on Overleaf needs the file ID. Refresh first.', 'configuration');
      // Overleaf's file tree delete; Overleaf keeps deleted files restorable in its history.
      await this.transport.deleteContent(this.transport.url(`/project/${p}/doc/${encodeURIComponent(action.docId)}`), this.csrf);
      return;
    }
    if (action.kind === 'edit') {
      if (!live || !action.docId || !action.path || action.version === undefined) throw new SyncError('Sending an edit needs the open project session.', 'configuration');
      const text = validateUpload(action.path, action.bytes!);
      // Re-read right before sending: the operation is built from this exact version.
      const doc = await live.rejoin(live.inspection.docs.find(item => item.docId === action.docId) ?? protocolError());
      if (doc.version !== action.version) throw new SyncError(`${action.path} changed on Overleaf just before sending. Get latest and review again.`, 'stale');
      const diffs = diffText(doc.text, text).diffs, { trackChanges, userId } = live.inspection;
      const tracking = trackChanges && userId && !action.untracked ? { userId, ts: new Date().toISOString() } : undefined;
      // With Track Changes on, edits become suggestions, as when typing in Overleaf.
      if (doc.otType === 'history-ot') await live.socket.applyEdit(doc, [{ textOperation: historyTextOp(doc, diffs, tracking) }], {}, this.csrf);
      else await live.socket.applyEdit(doc, shareJsOp(diffs), tracking ? { tc: trackedChangeSeed() } : {}, this.csrf);
      return;
    }
    if (action.kind === 'acceptChange' || action.kind === 'rejectChange') {
      if (!live || !action.docId || !action.change || action.version === undefined) throw new SyncError('Deciding a suggestion needs the open project session.', 'configuration');
      const doc = await live.rejoin(live.inspection.docs.find(item => item.docId === action.docId) ?? protocolError());
      if (doc.version !== action.version) throw new SyncError(`${action.path} changed on Overleaf just before sending. Get latest and review again.`, 'stale');
      const index = findSuggestion(doc, action.change), decision = action.kind === 'acceptChange' ? 'accept' : 'reject';
      if (index < 0) throw new SyncError(`${action.path}: this suggestion is no longer on Overleaf. Get latest and review again.`, 'stale');
      // Untracked on purpose: a decision never becomes a new suggestion.
      if (doc.otType === 'history-ot') await live.socket.applyEdit(doc, [{ textOperation: historyDecisionOp(doc, index, decision) }], {}, this.csrf);
      else if (decision === 'reject') await live.socket.applyEdit(doc, shareJsRejectOp(doc.changes[index]), {}, this.csrf);
      // The route Overleaf's review panel uses; it keeps the document version.
      else await this.transport.postContent(this.transport.url(`/project/${p}/doc/${encodeURIComponent(doc.docId)}/changes/accept`), JSON.stringify({ change_ids: [doc.changes[index].id] }), 'application/json', this.csrf);
      return;
    }
    let route: string, body: string | Buffer, type = 'application/json', remove = false;
    if (action.kind === 'upload') {
      validateTrackedFiles([action.path]);
      validateUpload(action.path!, action.bytes!);
      if (!action.folderId || !action.docId) throw new SyncError('Upload requires an existing document and folder. Refresh first.', 'configuration');
      const name = action.path!.split('/').at(-1)!;
      // Multipart headers cannot contain quotes/newlines from a file name.
      if (/["\r\n]/.test(name)) throw new SyncError('Unsupported upload filename.', 'configuration');
      const boundary = `turnleaf-${randomUUID()}`;
      const field = (key: string, value: string) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`);
      body = Buffer.concat([field('targetFolderId', action.folderId), field('name', name), field('type', 'text/plain'), Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="qqfile"; filename="${name}"\r\nContent-Type: text/plain\r\n\r\n`), action.bytes!, Buffer.from(`\r\n--${boundary}--\r\n`)]);
      type = `multipart/form-data; boundary=${boundary}`;
      route = `/project/${p}/upload?folder_id=${encodeURIComponent(action.folderId)}`;
    } else if (action.kind === 'reply') {
      route = `/project/${p}/thread/${encodeURIComponent(action.threadId!)}/messages`;
      body = JSON.stringify({ content: action.text });
    } else if (action.kind === 'editMessage' || action.kind === 'deleteMessage') {
      if (!action.threadId || !action.messageId) throw new SyncError('Refresh this message before editing it.', 'configuration');
      // Routes used by Overleaf's review-panel/context/threads-context.tsx.
      route = `/project/${p}/thread/${encodeURIComponent(action.threadId)}/${action.kind === 'deleteMessage' ? 'own-messages' : 'messages'}/${encodeURIComponent(action.messageId)}${action.kind === 'editMessage' ? '/edit' : ''}`;
      body = JSON.stringify({ content: action.text }); remove = action.kind === 'deleteMessage';
    } else {
      if (!action.docId || !action.threadId) throw new SyncError('Cannot locate this thread in a document.', 'configuration');
      route = `/project/${p}/doc/${encodeURIComponent(action.docId)}/thread/${encodeURIComponent(action.threadId)}${action.kind === 'deleteThread' ? '' : '/' + action.kind}`;
      remove = action.kind === 'deleteThread';
      body = '';
    }
    // A write is never retried automatically, including an ambiguous response.
    const response = await (remove ? this.transport.deleteContent(this.transport.url(route), this.csrf) : this.transport.postContent(this.transport.url(route), body, type, this.csrf));
    if (action.kind === 'upload') {
      let data: any;
      try { data = JSON.parse(response); } catch { throw new SyncError('Overleaf gave an unclear answer to the upload. Get latest to check what reached Overleaf before sending again.', 'upload'); }
      if (data.success !== true || (data.entity_id && data.entity_id !== action.docId) || (data.entity_type && data.entity_type !== 'doc')) throw new SyncError('Overleaf did not confirm the upload to the existing document. Get latest to check what reached Overleaf before sending again.', 'upload');
    }
  }
}

export interface RefreshScope { threads?: boolean; docs?: 'all' | 'changed' | string[]; }
export interface RemoteSession {
  readonly inspection: Inspection; socket: ReadSocket; rejoin(doc: DocState): Promise<DocState>;
  /** Joins the selected document `path`, just created as `docId`, and adds it to the inspection; `tree` replaces the known folders and files. */
  track(path: string, docId: string, folderId: string, tree?: ProjectTree): Promise<DocState>;
  /** Leaves and forgets the selected document `path`, just deleted. */
  untrack(path: string, tree?: ProjectTree): Promise<void>;
  /** Re-reads over the same connection: comments, then all, changed or listed documents. */
  refresh(scope?: RefreshScope): Promise<Inspection>;
  close(): Promise<void>;
}
