import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Realtime text edits are applied with the pinned Overleaf reference code, from
// the compiled tests (.test-dist/test) or the bundled editor test (dist).
const referenceRoot = [resolve('test/reference'), join(__dirname, '../../test/reference'), join(__dirname, '../test/reference')].find(existsSync);
const reference = (path: string) => { if (!referenceRoot) throw new Error('Pinned Overleaf reference code not found.'); return require(join(referenceRoot, path)); };
const unescaped = (s: string) => Buffer.from(s, 'latin1').toString('utf8');

export const fixtureCookie = 'fictional-fixture-session';
export const fixtureOwner = '0123456789abcdef01234567';
const escaped = (s: string) => Buffer.from(s, 'utf8').toString('latin1');
export const modernReply = [{
  content: 'Alpha old βeta.\nSecond line.\n',
  comments: [
    { id: 'c1', ranges: [{ pos: 0, length: 5 }] },
    { id: 'c2', ranges: [{ pos: 6, length: 4 }, { pos: 10, length: 4 }] },
    { id: 'c3', ranges: [] },
    { id: 'c4', ranges: [{ pos: 999, length: 2 }] },
  ],
  trackedChanges: [
    { range: { pos: 6, length: 4 }, tracking: { type: 'delete', userId: 'reviewer', ts: '2026-10-19T12:00:00Z' } },
    { range: { pos: 10, length: 4 }, tracking: { type: 'insert', userId: 'reviewer', ts: '2026-10-19T12:00:01Z' } },
  ],
}, 7, [], {}, 'history-ot'];
export const legacyReply = [[escaped('Jörg cite.'), ''], 9, [], {
  comments: [{ op: { p: 0, c: escaped('Jörg'), t: 'legacy' } }],
  changes: [{ id: 'lc', op: { p: 5, d: escaped('draft ') }, metadata: { user_id: 'reviewer', ts: '2026-10-19T12:00:00Z' } }],
}, 'sharejs-text-ot'];

// trackChanges: whether the signed-in owner has Track Changes on (default on).
// maxUploadSize: the project page's ol-ExposedSettings limit (none when unset).
export async function startFixtureServer(options: { writable?: boolean; trackChanges?: boolean; maxUploadSize?: number } = {}) {
  const requests: { method: string; path: string; packet?: string }[] = [];
  const sockets = new Map<string, string[]>();
  let socketId = 0;
  let forbiddenThreadReads = 0;
  const replies: Record<string, any[]> = { modern: structuredClone(modernReply), legacy: structuredClone(legacyReply) };
  let failUpload = '';
  let failAnchor = false;
  let uploadEventDelayMs = 0, threadReadDelayMs = 0;
  // The project tree, as joinProject sends it. Created documents are history-ot.
  const tree: any = { _id: 'root-folder', docs: [{ _id: 'modern', name: 'main.tex' }, { _id: 'legacy', name: 'references.bib' }], fileRefs: [], folders: [] };
  let entityId = 0, failCreate: { name: string; when: 'before' | 'after' | 'refuse' } | undefined;
  let rejectedJoins = 0;
  let failPicture: { name: string; when: 'before' | 'after' | 'refuse' | 'unclear' } | undefined;
  const newId = () => (0xf00000 + ++entityId).toString(16).padStart(24, '0');
  const findFolder = (id: string, folder: any = tree): any => folder._id === id ? folder : folder.folders.map((child: any) => findFolder(id, child)).find(Boolean);
  const entries = (folder: any) => [...folder.docs, ...folder.fileRefs, ...folder.folders];
  const tell = (name: string, args: unknown[]) => { for (const queue of sockets.values()) queue.push('5:::' + JSON.stringify({ name, args })); };
  // Stored bytes of non-text files by Git blob SHA-1, as the blob route serves them.
  const blobs = new Map<string, Buffer>();
  let corruptDownloads = false, blobRouteMissing = false;
  const blobHash = (bytes: Buffer) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  // Another client adds a document (with `text`), a non-text file (with its bytes) or a folder at `path`.
  function addEntry(path: string, kind: 'doc' | 'file' | 'folder', text: string | Buffer = '', file: { linked?: boolean } = {}) {
    const parts = path.split('/');
    let folder = tree;
    for (const [n, name] of parts.slice(0, -1).entries()) folder = folder.folders.find((child: any) => child.name === name) ?? addEntry(parts.slice(0, n + 1).join('/'), 'folder');
    const id = newId(), name = parts.at(-1)!;
    if (kind === 'doc') { folder.docs.push({ _id: id, name }); replies[id] = [{ content: String(text), comments: [], trackedChanges: [] }, 1, [], {}, 'history-ot']; }
    else if (kind === 'file') { const bytes = Buffer.from(text), hash = blobHash(bytes); blobs.set(hash, bytes); folder.fileRefs.push({ _id: id, name, hash, linkedFileData: file.linked ? { provider: 'url', url: 'https://example.org/figure.png' } : null, created: new Date().toISOString() }); }
    else { const created = { _id: id, name, docs: [], fileRefs: [], folders: [] }; folder.folders.push(created); return created; }
    return { _id: id };
  }
  const findFile = (path: string) => { const parts = path.split('/'); let folder = tree; for (const name of parts.slice(0, -1)) folder = folder?.folders.find((child: any) => child.name === name); return folder?.fileRefs.find((f: any) => f.name === parts.at(-1)); };
  const threads: Record<string, any> = Object.fromEntries(['c1', 'c2', 'c3', 'c4', 'legacy', 'elsewhere'].map(id => [id, { resolved: id === 'c2', messages: [{ id: `${id}-m1`, user: { id: id === 'c1' ? fixtureOwner : 'reviewer', name: 'Fixture Reviewer' }, content: `Review ${id}: verify the claim.`, timestamp: '2026-10-19T12:00:00Z' }] }]));
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://fixture');
    const entry: { method: string; path: string; packet?: string } = { method: req.method!, path: url.pathname };
    requests.push(entry);
    if (req.headers.cookie !== `overleaf_session2=${fixtureCookie}`) {
      res.writeHead(302, { Location: '/login' }).end(); return;
    }
    if (options.writable && ['POST', 'DELETE'].includes(req.method!) && url.pathname.startsWith('/project/test-project/')) {
      if (req.headers['x-csrf-token'] !== 'fixture-csrf') { res.writeHead(403).end(); return; }
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(Buffer.from(c)); const raw = Buffer.concat(chunks), body = raw.toString('utf8');
      // Overleaf's file tree: New file and New folder refuse a name that exists in the folder.
      const creation = /^\/project\/test-project\/(doc|folder)$/.exec(url.pathname);
      if (creation && req.method === 'POST') {
        const { name, parent_folder_id: parentId } = JSON.parse(body), parent = findFolder(parentId);
        if (!parent || typeof name !== 'string' || !name || name.includes('/')) { res.writeHead(400).end('invalid'); return; }
        if (failCreate?.name === name && failCreate.when === 'refuse') { res.writeHead(422).end(JSON.stringify({ message: 'invalid name' })); return; }
        if (failCreate?.name === name && failCreate.when === 'before') { res.writeHead(500).end(); return; }
        if (entries(parent).some((entry: any) => entry.name === name)) { res.writeHead(400).end(JSON.stringify({ message: 'file already exists' })); return; }
        const id = newId();
        if (creation[1] === 'doc') { parent.docs.push({ _id: id, name }); replies[id] = [{ content: '', comments: [], trackedChanges: [] }, 0, [], {}, 'history-ot']; }
        else parent.folders.push({ _id: id, name, docs: [], fileRefs: [], folders: [] });
        tell(creation[1] === 'doc' ? 'reciveNewDoc' : 'reciveNewFolder', [parentId, { _id: id, name }]);
        if (failCreate?.name === name) { res.writeHead(500).end(); return; }
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ _id: id, name })); return;
      }
      const removal = /^\/project\/test-project\/(doc|folder|file)\/([^/]+)$/.exec(url.pathname);
      if (removal && req.method === 'DELETE') {
        const holder = (folder: any): any => entries(folder).some((entry: any) => entry._id === removal[2]) ? folder : folder.folders.map(holder).find(Boolean);
        const parent = holder(tree);
        if (!parent) { res.writeHead(404).end(); return; }
        for (const list of ['docs', 'fileRefs', 'folders']) parent[list] = parent[list].filter((entry: any) => entry._id !== removal[2]);
        delete replies[removal[2]]; tell('removeEntity', [removal[2]]);
        res.writeHead(204).end(); return;
      }
      const uploaded = /filename="([^"]+)"/.exec(body)?.[1];
      if (url.pathname.endsWith('/upload') && uploaded && /\.(png|jpe?g|pdf)$/i.test(uploaded)) {
        // A picture, as Overleaf stores an upload: a new file ID, replacing any entry of that
        // name in the folder (a document loses its comments, a linked file its link).
        const boundary = /boundary=([^;]+)/.exec(String(req.headers['content-type']))?.[1], folder = findFolder(url.searchParams.get('folder_id') ?? '');
        const head = raw.indexOf('\r\n\r\n', raw.indexOf(`filename="${uploaded}"`)), end = boundary ? raw.lastIndexOf(`\r\n--${boundary}--`) : -1;
        if (!folder || head < 0 || end < head) { res.writeHead(400).end(); return; }
        const fail = failPicture?.name === uploaded ? failPicture.when : undefined;
        if (fail === 'refuse') { res.writeHead(422).end(JSON.stringify({ success: false, error: 'invalid_filename' })); return; }
        if (fail === 'before') { res.writeHead(500).end(); return; }
        const bytes = raw.subarray(head + 4, end), hash = blobHash(bytes), id = newId();
        blobs.set(hash, Buffer.from(bytes));
        for (const list of ['docs', 'fileRefs']) for (const old of folder[list].filter((entry: any) => entry.name === uploaded)) { folder[list] = folder[list].filter((entry: any) => entry !== old); delete replies[old._id]; tell('removeEntity', [old._id, 'upload']); }
        const file = { _id: id, name: uploaded, hash, linkedFileData: null, created: new Date().toISOString() };
        folder.fileRefs.push(file); tell('reciveNewFile', [folder._id, file, 'upload', null, fixtureOwner]);
        if (fail === 'after') { res.writeHead(500).end(); return; }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(fail === 'unclear' ? { success: true, entity_id: id, entity_type: 'file' } : { success: true, entity_id: id, entity_type: 'file', hash })); return;
      }
      if (url.pathname.endsWith('/upload')) {
        const name = uploaded, id = name === 'main.tex' ? 'modern' : 'legacy';
        if (name === failUpload) { res.writeHead(500).end(); return; }
        const text = /filename="[^"]+"\r\nContent-Type: [^\r]+\r\n\r\n([\s\S]*?)\r\n--/.exec(body)?.[1];
        if (text === undefined || url.searchParams.get('folder_id') !== 'root-folder') { res.writeHead(400).end(); return; }
        const version = replies[id][1];
        if (id === 'modern') { replies[id][0] = { content: text, comments: [{ id: 'c1', ranges: [{ pos: 0, length: Math.min(5, text.length) }] }], trackedChanges: [] }; }
        else { replies[id][0] = text.split('\n').map(escaped); replies[id][3] = { comments: [], changes: [] }; }
        replies[id][1]++;
        const event = '5:::' + JSON.stringify({ name: 'otUpdateApplied', args: [{ doc: id, v: version, meta: { user_id: fixtureOwner, type: 'external', source: 'upload', ts: Date.now() } }] });
        if (uploadEventDelayMs) setTimeout(() => { for (const queue of sockets.values()) queue.push(event); }, uploadEventDelayMs).unref();
        else for (const queue of sockets.values()) queue.push(event);
        res.end(JSON.stringify({ success: true, entity_id: id, entity_type: 'doc' })); return;
      }
      const reply = /\/thread\/([^/]+)\/messages$/.exec(url.pathname);
      if (reply) { threads[reply[1]] ??= { resolved: false, messages: [] }; threads[reply[1]].messages.push({ id: `reply-${threads[reply[1]].messages.length}`, user: { id: fixtureOwner, name: 'Author' }, content: JSON.parse(body).content }); res.end('{}'); return; }
      const messageRoute = /\/thread\/([^/]+)\/(messages|own-messages)\/([^/]+)(\/edit)?$/.exec(url.pathname);
      if (messageRoute) {
        const thread = threads[messageRoute[1]], message = thread?.messages.find((m: any) => m.id === messageRoute[3]);
        if (!message) { res.writeHead(404).end(); return; }
        if (message.user.id !== fixtureOwner) { res.writeHead(403).end(); return; }
        if (messageRoute[4] && req.method === 'POST') message.content = JSON.parse(body).content;
        else if (req.method === 'DELETE') thread.messages = thread.messages.filter((m: any) => m.id !== message.id);
        else { res.writeHead(405).end(); return; }
        res.end('{}'); return;
      }
      const threadDeletion = /\/doc\/([^/]+)\/thread\/([^/]+)$/.exec(url.pathname);
      if (threadDeletion && req.method === 'DELETE') { delete threads[threadDeletion[2]]; res.end('{}'); return; }
      const resolution = /\/thread\/([^/]+)\/(resolve|reopen)$/.exec(url.pathname);
      if (resolution && threads[resolution[1]]) { threads[resolution[1]].resolved = resolution[2] === 'resolve'; res.end('{}'); return; }
      // Like Overleaf, accepting sharejs suggestions keeps the document version.
      const accept = /\/doc\/legacy\/changes\/accept$/.exec(url.pathname);
      if (accept) { const ids: string[] = JSON.parse(body).change_ids; replies.legacy[3].changes = replies.legacy[3].changes.filter((c: any) => !ids.includes(c.id)); res.writeHead(204).end(); return; }
      res.writeHead(404).end(); return;
    }
    if (url.pathname === '/project') {
      const projects = JSON.stringify({ projects: [{ id: 'test-project', name: 'Fixture Review', lastUpdated: '2026-10-19' }] }).replaceAll('"', '&quot;');
      const exposed = options.maxUploadSize ? `<meta name="ol-ExposedSettings" data-type="json" content="${JSON.stringify({ maxUploadSize: options.maxUploadSize }).replaceAll('"', '&quot;')}">` : '';
      res.end(`<meta name="ol-csrfToken" content="fixture-csrf"><meta name="ol-user_id" content="${fixtureOwner}"><meta name="ol-prefetchedProjectsBlob" content="${projects}">${exposed}`); return;
    }
    // Non-text file bytes: the history blob route (with the file route as its
    // fallback), and the file route by file ID.
    const blob = /^\/project\/test-project\/blob\/([0-9a-f]{40})$/.exec(url.pathname), fileRoute = /^\/project\/test-project\/file\/([0-9a-f]{24})$/.exec(url.pathname);
    if (req.method === 'GET' && (blob || fileRoute)) {
      const find = (id: string, folder: any = tree): any => folder.fileRefs.find((f: any) => f._id === id) ?? folder.folders.map((child: any) => find(id, child)).find(Boolean);
      const bytes = blob ? blobRouteMissing ? undefined : blobs.get(blob[1]) : blobs.get(find(fileRoute![1])?.hash);
      if (!bytes) { res.writeHead(404).end('Not found'); return; }
      res.setHeader('Content-Type', 'application/octet-stream');
      res.end(corruptDownloads ? Buffer.concat([bytes, Buffer.from('!')]) : bytes); return;
    }
    if (url.pathname === '/project/test-project/threads') {
      if (threadReadDelayMs) await new Promise<void>(resolve => { const timer = setTimeout(resolve, threadReadDelayMs); res.once('close', () => { clearTimeout(timer); resolve(); }); });
      if (forbiddenThreadReads > 0) { forbiddenThreadReads--; res.writeHead(403).end('forbidden'); return; }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(threads)); return;
    }
    if (url.pathname === '/socket.io/1/') {
      const sid = `fixture-${++socketId}`;
      const event = '5:::' + JSON.stringify({ name: 'joinProjectResponse', args: [{ publicId: 'fixture-public', permissionsLevel: 'owner', protocolVersion: 2, project: { name: 'Fixture Review', owner: { _id: fixtureOwner }, trackChangesState: { [fixtureOwner]: options.trackChanges ?? true, __guests__: false }, rootDoc_id: 'modern', rootFolder: [structuredClone(tree)] } }] });
      if (rejectedJoins > 0) { rejectedJoins--; sockets.set(sid, ['5:::' + JSON.stringify({ name: 'connectionRejected', args: [{ message: 'rate-limit hit when joining project', code: 'TooManyRequests' }] }), '0::']); }
      else sockets.set(sid, [event]);
      res.end(`${sid}:60:60:xhr-polling`); return;
    }
    const sid = url.pathname.split('/').at(-1)!;
    const queue = sockets.get(sid);
    if (!queue) { res.writeHead(404).end(); return; }
    if (req.method === 'GET') {
      res.end(queue.shift() ?? '8::'); return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const packet = Buffer.concat(chunks).toString();
    entry.packet = packet;
    if (packet === '0::') { sockets.delete(sid); res.end('1'); return; }
    if (packet === '2::') { res.end('1'); return; }
    const match = /^5:(\d+)\+::(.+)$/.exec(packet);
    if (!match) { res.writeHead(400).end(); return; }
    const event = JSON.parse(match[2]);
    if (event.name === 'joinDoc') {
      const reply = replies[event.args[0]];
      const ack = `6:::${match[1]}+${JSON.stringify(reply ? [null, ...reply] : ['document not found'])}`;
      queue.push(`\ufffd3\ufffd2::\ufffd${ack.length}\ufffd${ack}`);
    } else if (event.name === 'applyOtUpdate' && options.writable) {
      const [docId, update] = event.args, reply = replies[docId], op = update.op?.[0], history = reply?.[4] === 'history-ot';
      const textEdit = history ? Array.isArray(op?.textOperation) : Array.isArray(update.op) && update.op.every((c: any) => typeof c.p === 'number' && (typeof c.i === 'string' || typeof c.d === 'string'));
      if (failAnchor && !textEdit) { res.writeHead(500).end('Anchor failure'); return; }
      if (!reply || update.v !== reply[1] || !op || update.op.length !== 1 && !textEdit) { res.writeHead(409).end(); return; }
      if (history && textEdit) {
        const file = reference('editor-core/lib/file_data/string_file_data.js').fromRaw(reply[0]);
        file.edit(reference('editor-core/lib/operation/text_operation.js').fromJSON(op)); reply[0] = file.toRaw();
      } else if (!history && textEdit) {
        const comments = (reply[3].comments ?? []).map((c: any) => ({ ...c, op: { ...c.op, c: unescaped(c.op.c) } }));
        const changes = (reply[3].changes ?? []).map((c: any) => ({ ...c, op: { p: c.op.p, ...c.op.i !== undefined ? { i: unescaped(c.op.i) } : { d: unescaped(c.op.d) } } }));
        const tracker = new (reference('ranges-tracker.cjs'))(changes, comments);
        if (update.meta?.tc) { tracker.track_changes = true; tracker.setIdSeed(update.meta.tc); }
        let text = reply[0].map(unescaped).join('\n');
        for (const c of update.op) text = c.i !== undefined ? text.slice(0, c.p) + c.i + text.slice(c.p) : text.slice(0, c.p) + text.slice(c.p + c.d.length);
        tracker.applyOps(update.op, { user_id: fixtureOwner, ts: new Date().toISOString() });
        reply[0] = text.split('\n').map(escaped);
        reply[3] = { comments: tracker.comments.map((c: any) => ({ ...c, op: { ...c.op, c: escaped(c.op.c) } })), changes: tracker.changes.map((c: any) => ({ ...c, op: { p: c.op.p, ...c.op.i !== undefined ? { i: escaped(c.op.i) } : { d: escaped(c.op.d) } } })) };
      } else if (history && typeof op.commentId === 'string' && Array.isArray(op.ranges)) reply[0].comments.push({ id: op.commentId, ranges: op.ranges });
      else if (!history && typeof op.t === 'string' && typeof op.c === 'string') reply[3].comments.push({ op: { ...op, c: escaped(op.c) } });
      else { res.writeHead(400).end('Unexpected mutation'); return; }
      // Like Overleaf: the sender gets a bare acknowledgement, everyone else the operation.
      if (textEdit) for (const [id, other] of sockets) other.push('5:::' + JSON.stringify({ name: 'otUpdateApplied', args: [id === sid ? { doc: docId, v: reply[1] } : { doc: docId, v: reply[1], op: update.op, meta: { user_id: fixtureOwner } }] }));
      reply[1]++; queue.push(`6:::${match[1]}+[null]`);
    } else if (event.name === 'leaveDoc') {
      queue.push(`6:::${match[1]}+[null]`);
    } else { res.writeHead(400).end('Mutation rejected'); return; }
    res.end('1');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, sockets,
    forbidNextThreadReads(count: number) { forbiddenThreadReads = count; },
    failAnchor(value: boolean) { failAnchor = value; },
    failUpload(path: string) { failUpload = path; },
    delayUploadEvents(ms: number) { uploadEventDelayMs = ms; },
    delayThreadReads(ms: number) { threadReadDelayMs = ms; },
    /** 'before': refuse creating `name` with HTTP 500; 'after': create it, then answer HTTP 500. */
    failCreate(name: string, when: 'before' | 'after' | 'refuse' = 'before') { failCreate = { name, when }; },
    /** A picture upload of `name`: 'before' answers HTTP 500 and stores nothing, 'after' stores it and answers 500, 'refuse' answers 422, 'unclear' stores it and leaves the hash out of the answer. */
    /** The next `count` connections are refused as over Overleaf's per-minute limit on opening a project. */
    rejectJoins(count: number) { rejectedJoins = count; },
    failPicture(name: string, when: 'before' | 'after' | 'refuse' | 'unclear' = 'before') { failPicture = { name, when }; },
    addEntry, tree, findFile, blobs,
    /** Another client replaces a non-text file's bytes (a new hash, the same file ID). */
    replaceFile(path: string, bytes: Buffer) { const file = findFile(path); if (!file) throw new Error(`No file ${path}`); const hash = blobHash(bytes); blobs.set(hash, bytes); file.hash = hash; },
    /** Takes a non-text file out of the tree, as deleting it on Overleaf does. */
    removeFile(path: string) { const parts = path.split('/'); let folder = tree; for (const name of parts.slice(0, -1)) folder = folder.folders.find((child: any) => child.name === name); folder.fileRefs = folder.fileRefs.filter((f: any) => f.name !== parts.at(-1)); },
    /** Downloads then return one byte too many, so they no longer match the tree's hash. */
    corruptDownloads(value: boolean) { corruptDownloads = value; },
    /** The blob route answers 404, as for a file without a history blob. */
    blobRouteMissing(value: boolean) { blobRouteMissing = value; },
    requestsFor: (pattern: RegExp) => requests.filter(r => pattern.test(r.path)),
    /** A server event to every open socket, e.g. another client's `otUpdateApplied`. */
    emit: tell,
    /** Takes a document out of the tree, as deleting it on Overleaf does. */
    removeDoc(id: string) { const drop = (folder: any): void => { const index = folder.docs.findIndex((doc: any) => doc._id === id); if (index >= 0) folder.docs.splice(index, 1); folder.folders.forEach(drop); }; drop(tree); },
    replies, threads,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}
