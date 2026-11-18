// Read-and-upload probe for non-text files (pictures, PDF figures) on a throwaway Overleaf
// Community Edition instance (scripts/ce.mjs --binary). It answers design questions and is
// never bundled into the extension: what the joinProject tree says about each file, which
// routes download and delete one, what an upload under an existing name does, how linked
// files look, and the upload size limit. Writes only to the projects this CE run created.
import { createHash, randomBytes } from 'node:crypto';
import { CeSession, CeSocket } from './client';
import type { SeededProject } from './harness';

type Json = any;
const objectId = /\b[0-9a-f]{24}\b/g, sha1 = /\b[0-9a-f]{40}\b/g;
/** Raw shapes with throwaway IDs and hashes replaced, so the record keeps structure only. */
const redact = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null).replace(sha1, '<sha1>').replace(objectId, '<id>'));
const gitBlobSha1 = (bytes: Buffer) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const plainSha1 = (bytes: Buffer) => createHash('sha1').update(bytes).digest('hex');
const md5 = (bytes: Buffer) => createHash('md5').update(bytes).digest('hex');

// A valid 1×1 PNG and a minimal one-page PDF; the JPG is random bytes after a JPEG header,
// so it is not valid UTF-8 (Overleaf decides by name and content, not by decoding the image).
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cfc0f01f0005fe02fea7d6a42d0000000049454e44ae426082', 'hex');
const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1');
const jpg = (size: number) => Buffer.concat([Buffer.from('ffd8ffe000104a464946', 'hex'), randomBytes(size)]);

interface Raw { status: number; headers: Record<string, string>; bytes: Buffer; }

export async function binaryProbe(baseUrl: string, session: CeSession, projects: SeededProject[]) {
  const errors: { step: string; message: string }[] = [];
  const result: Record<string, unknown> = { errors };
  const step = async <T>(name: string, action: () => Promise<T>): Promise<T | undefined> => {
    try { const value = await action(); result[name] = value; return value; }
    catch (error) { errors.push({ step: name, message: error instanceof Error ? error.message.replace(sha1, '<sha1>').replace(objectId, '<id>') : String(error) }); return undefined; }
  };
  await session.page('/project');
  const [a, b] = projects.map(project => project.projectId);

  /** One request whose answer is kept as bytes (CeSession reads answers as text). */
  const raw = async (path: string, init: { method?: string; form?: FormData; json?: unknown } = {}): Promise<Raw> => {
    const method = init.method ?? (init.form || init.json !== undefined ? 'POST' : 'GET');
    const headers: Record<string, string> = { Accept: 'application/json, */*' };
    if (session.csrfToken && method !== 'GET' && method !== 'HEAD') headers['X-Csrf-Token'] = session.csrfToken;
    headers.Cookie = [...session.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    let body: FormData | string | undefined = init.form;
    if (init.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(init.json); }
    const response = await fetch(new URL(path, baseUrl), { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(300_000) });
    const kept: Record<string, string> = {};
    for (const name of ['content-type', 'content-length', 'content-disposition', 'etag', 'last-modified', 'cache-control', 'location', 'x-served-by']) {
      const value = response.headers.get(name);
      if (value !== null) kept[name] = value.replace(sha1, '<sha1>').replace(objectId, '<id>');
    }
    return { status: response.status, headers: kept, bytes: Buffer.from(await response.arrayBuffer()) };
  };
  const answer = (response: Raw) => {
    const text = response.bytes.toString('utf8');
    let body: unknown = text.length > 300 ? `${text.slice(0, 300).replace(/\s+/g, ' ')}…` : text;
    try { body = JSON.parse(text); } catch { /* text */ }
    return { status: response.status, headers: response.headers, body: redact(body) };
  };
  const upload = async (projectId: string, folderId: string, name: string, bytes: Buffer, extra: Record<string, string> = {}) => {
    const form = new FormData();
    form.append('name', name);
    for (const [key, value] of Object.entries(extra)) form.append(key, value);
    form.append('qqfile', new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }), name);
    const response = await raw(`/project/${projectId}/upload?folder_id=${folderId}`, { form });
    let json: Json; try { json = JSON.parse(response.bytes.toString('utf8')); } catch { /* not JSON */ }
    return { response, json };
  };
  /** The project tree from joinProject, as the extension receives it. */
  const tree = async (projectId: string) => {
    const socket = new CeSocket(session, projectId);
    try { return (await socket.open()).project as Json; } finally { await socket.close(); }
  };
  const entries = (project: Json) => {
    const out: { path: string; kind: 'doc' | 'file' | 'folder'; entry: Json; folderId: string }[] = [];
    const walk = (folder: Json, prefix: string) => {
      for (const doc of folder.docs ?? []) out.push({ path: prefix + doc.name, kind: 'doc', entry: doc, folderId: folder._id });
      for (const file of folder.fileRefs ?? []) out.push({ path: prefix + file.name, kind: 'file', entry: file, folderId: folder._id });
      for (const child of folder.folders ?? []) { out.push({ path: prefix + child.name, kind: 'folder', entry: { _id: child._id, name: child.name }, folderId: folder._id }); walk(child, prefix + child.name + '/'); }
    };
    for (const root of project.rootFolder ?? []) walk(root, '');
    return out;
  };
  const find = (project: Json, path: string) => entries(project).filter(entry => entry.path === path);
  const fingerprint = (entry: Json, bytes: Buffer) => ({
    hashField: typeof entry?.hash === 'string' ? (entry.hash === gitBlobSha1(bytes) ? 'git blob SHA-1 of the content' : entry.hash === plainSha1(bytes) ? 'plain SHA-1 of the content' : entry.hash === md5(bytes) ? 'MD5 of the content' : 'other') : 'absent',
  });

  const before = await tree(a), root: string = before.rootFolder[0]._id;
  await step('exposedSettings', async () => {
    const html = await session.page('/project');
    const settings = JSON.parse(session.meta(html, 'ol-ExposedSettings') ?? '{}');
    return Object.fromEntries(Object.entries(settings).filter(([key]) => /size|upload|linked|entities|max/i.test(key)));
  });
  await step('textDocEntryShape', async () => redact(before.rootFolder[0].docs?.[0]));

  // 1. Upload new files and read them back from the tree.
  const created = await step('uploadNew', async () => {
    const out: Record<string, unknown> = {};
    for (const [name, bytes] of [['probe.png', png], ['probe.pdf', pdf], ['probe.jpg', jpg(2000)]] as const) {
      const { response, json } = await upload(a, root, name, bytes);
      const [entry] = find(await tree(a), name);
      out[name] = { answer: answer(response), entityIdIsTreeId: json?.entity_id === entry?.entry._id, treeKind: entry?.kind, fileRef: redact(entry?.entry), fileRefKeys: Object.keys(entry?.entry ?? {}).sort(), ...fingerprint(entry?.entry, bytes), bytes: bytes.length };
    }
    return out;
  });

  // 2. Download routes: by file ID, HEAD, and by content hash.
  const pngEntry = find(await tree(a), 'probe.png')[0]?.entry;
  await step('download', async () => {
    if (!pngEntry) throw new Error('probe.png is not in the tree');
    const get = await raw(`/project/${a}/file/${pngEntry._id}`), head = await raw(`/project/${a}/file/${pngEntry._id}`, { method: 'HEAD' });
    const out: Record<string, unknown> = {
      'GET /project/:id/file/:fileId': { status: get.status, headers: get.headers, sameBytes: get.bytes.equals(png) },
      'HEAD /project/:id/file/:fileId': { status: head.status, headers: head.headers },
    };
    if (typeof pngEntry.hash === 'string') {
      for (const route of [`/project/${a}/blob/${pngEntry.hash}`, `/project/${a}/blob/${pngEntry.hash}?fallback=${pngEntry._id}`]) {
        const response = await raw(route), head = await raw(route, { method: 'HEAD' });
        out[`GET ${route.replace(sha1, ':hash').replace(objectId, ':id')}`] = { status: response.status, headers: response.headers, sameBytes: response.bytes.equals(png) };
        out[`HEAD ${route.replace(sha1, ':hash').replace(objectId, ':id')}`] = { status: head.status, headers: head.headers };
      }
    }
    if (typeof pngEntry.hash === 'string') {
      const unknown = await raw(`/project/${a}/blob/${'0'.repeat(40)}`), foreign = await raw(`/project/${b ?? a}/blob/${pngEntry.hash}`);
      out['GET /project/:id/blob/:unknownHash'] = { status: unknown.status };
      out['GET /project/:otherProject/blob/:hash'] = { status: foreign.status, sameBytes: foreign.bytes.equals(png) };
    }
    const missing = await raw(`/project/${a}/file/${'0'.repeat(24)}`);
    out['GET /project/:id/file/:unknownId'] = { status: missing.status, headers: missing.headers };
    const other = await raw(`/project/${b ?? a}/file/${pngEntry._id}`);
    out['GET /project/:otherProject/file/:fileId'] = { status: other.status, sameBytes: other.bytes.equals(png) };
    return out;
  });
  await step('entitiesRoute', async () => answer(await raw(`/project/${a}/entities`)));

  // 3. Upload under an existing file name: replaced in place, same ID, or a second entry?
  await step('replaceExistingFile', async () => {
    const next = Buffer.concat([png, Buffer.from('replaced')]);
    const { response, json } = await upload(a, root, 'probe.png', next);
    const after = find(await tree(a), 'probe.png');
    const old = pngEntry && await raw(`/project/${a}/file/${pngEntry._id}`);
    const oldBlob = pngEntry?.hash && await raw(`/project/${a}/blob/${pngEntry.hash}`);
    return { answer: answer(response), entriesWithThatName: after.length, sameId: after[0]?.entry._id === pngEntry?._id, entityIdIsTreeId: json?.entity_id === after[0]?.entry._id,
      fileRef: redact(after[0]?.entry), ...fingerprint(after[0]?.entry, next), hashChanged: after[0]?.entry.hash !== pngEntry?.hash,
      oldFileIdDownload: old && { status: old.status, sameAsOldBytes: old.bytes.equals(png), sameAsNewBytes: old.bytes.equals(next) },
      oldHashDownload: oldBlob && { status: oldBlob.status, sameAsOldBytes: oldBlob.bytes.equals(png) } };
  });
  await step('replaceWithSameBytes', async () => {
    const [current] = find(await tree(a), 'probe.pdf');
    const { response } = await upload(a, root, 'probe.pdf', pdf);
    const [after] = find(await tree(a), 'probe.pdf');
    return { answer: answer(response), sameId: after?.entry._id === current?.entry._id, sameHash: after?.entry.hash === current?.entry.hash };
  });

  // 4. Upload a picture under the name of a text document, and the reverse.
  await step('binaryOverTextDoc', async () => {
    const created = await session.json(`/project/${a}/doc`, { json: { name: 'clash.png', parent_folder_id: root } });
    const { response, json } = await upload(a, root, 'clash.png', png);
    const after = find(await tree(a), 'clash.png');
    return { createdDoc: Boolean(created?._id), answer: answer(response), entries: after.map(entry => entry.kind), docIdKept: after.some(entry => entry.entry._id === created?._id), entityType: json?.entity_type };
  });
  await step('binaryOverTexDoc', async () => {
    const [doc] = find(await tree(a), 'main.tex');
    const bytes = jpg(500);
    const { response } = await upload(a, root, 'main.tex', bytes);
    const after = find(await tree(a), 'main.tex');
    return { before: doc?.kind, answer: answer(response), entries: after.map(entry => entry.kind), docIdKept: after.some(entry => entry.entry._id === doc?.entry._id) };
  });
  await step('textOverBinaryFile', async () => {
    const [file] = find(await tree(a), 'main.tex');
    const { response } = await upload(a, root, 'main.tex', Buffer.from('\\documentclass{article}\n\\begin{document}Back to text.\\end{document}\n'));
    const after = find(await tree(a), 'main.tex');
    return { before: file?.kind, answer: answer(response), entries: after.map(entry => entry.kind), idKept: after.some(entry => entry.entry._id === file?.entry._id) };
  });
  await step('largeTextUpload', async () => {
    const line = '@misc{key, note = {A long bibliography entry for the size probe.}}\n';
    const out: Record<string, unknown> = {};
    for (const size of [1024 * 1024 - 1000, 2 * 1024 * 1024 + 1000]) {
      const name = `big-${size}.bib`, bytes = Buffer.from(line.repeat(Math.ceil(size / line.length)).slice(0, size));
      const { response } = await upload(a, root, name, bytes);
      out[name] = { status: response.status, kind: find(await tree(a), name).map(entry => entry.kind) };
    }
    return out;
  });

  // 5. Uploading into a path that does not exist yet (Overleaf's folder upload).
  await step('uploadWithRelativePath', async () => {
    const { response } = await upload(a, root, 'nested.png', png, { relativePath: 'figures/sub/nested.png' });
    return { answer: answer(response), paths: entries(await tree(a)).filter(entry => /nested\.png$|^figures/.test(entry.path)).map(entry => `${entry.kind} ${entry.path}`) };
  });

  // 6. Delete a file, then read it again.
  await step('deleteFile', async () => {
    const [entry] = find(await tree(a), 'probe.jpg');
    if (!entry) throw new Error('probe.jpg is not in the tree');
    const response = await raw(`/project/${a}/file/${entry.entry._id}`, { method: 'DELETE' });
    const after = find(await tree(a), 'probe.jpg'), download = await raw(`/project/${a}/file/${entry.entry._id}`);
    const blob = entry.entry.hash && await raw(`/project/${a}/blob/${entry.entry.hash}`);
    const asDoc = await raw(`/project/${a}/doc/${find(await tree(a), 'probe.pdf')[0]?.entry._id}`, { method: 'DELETE' });
    return { answer: answer(response), inTreeAfter: after.length, downloadAfter: download.status, blobAfter: blob ? blob.status : 'no hash',
      'DELETE /project/:id/doc/:fileId (a file through the doc route)': { status: asDoc.status, pdfStillInTree: find(await tree(a), 'probe.pdf').length } };
  });

  // 7. Linked files: from another project, and from a URL (CE fetches it itself).
  if (b) await step('linkedFromProject', async () => {
    const source = await tree(b), sourceRoot = source.rootFolder[0]._id;
    await upload(b, sourceRoot, 'source.png', png);
    const response = await raw(`/project/${a}/linked_file`, { json: { name: 'linked.png', parent_folder_id: root, provider: 'project_file', data: { source_project_id: b, source_entity_path: '/source.png' } } });
    const [entry] = find(await tree(a), 'linked.png');
    const download = entry && await raw(`/project/${a}/file/${entry.entry._id}`);
    // The source changes: the linked copy changes only on refresh.
    await upload(b, sourceRoot, 'source.png', Buffer.concat([png, Buffer.from('v2')]));
    const [stale] = find(await tree(a), 'linked.png');
    const refresh = entry && await raw(`/project/${a}/linked_file/${entry.entry._id}/refresh`, { json: {} });
    const [refreshed] = find(await tree(a), 'linked.png');
    // What an upload over a linked file does.
    const { response: over } = await upload(a, root, 'linked.png', pdf);
    const [overwritten] = find(await tree(a), 'linked.png');
    return { answer: answer(response), fileRef: redact(entry?.entry), download: download && { status: download.status, sameBytes: download.bytes.equals(png) },
      unchangedBeforeRefresh: stale?.entry.hash === entry?.entry.hash, refresh: refresh && answer(refresh), refreshChangedId: refreshed?.entry._id !== entry?.entry._id, refreshChangedHash: refreshed?.entry.hash !== entry?.entry.hash,
      uploadOverLinked: { status: over.status, stillLinked: Boolean(overwritten?.entry.linkedFileData), fileRef: redact(overwritten?.entry) } };
  });
  await step('linkedFromUrl', async () => {
    const response = await raw(`/project/${a}/linked_file`, { json: { name: 'from-url.png', parent_folder_id: root, provider: 'url', data: { url: 'http://127.0.0.1/favicon.ico' } } });
    return { answer: answer(response), inTree: find(await tree(a), 'from-url.png').map(entry => redact(entry.entry)) };
  });

  // 8. Size limit: one upload just over the exposed limit (or over 50 MB when none is exposed).
  await step('sizeLimit', async () => {
    const exposed = (result.exposedSettings as Record<string, unknown> | undefined)?.maxUploadSize;
    const limit = typeof exposed === 'number' ? exposed : 50 * 1024 * 1024;
    const out: Record<string, unknown> = { limitTried: limit };
    for (const [label, size] of [['atLimit', limit - 1024], ['overLimit', limit + 1]] as const) {
      const { response } = await upload(a, root, `${label}.pdf`, Buffer.concat([pdf, randomBytes(size - pdf.length)]));
      out[label] = { bytes: size, ...answer(response), inTree: find(await tree(a), `${label}.pdf`).length };
    }
    return out;
  });
  result.finalTree = entries(await tree(a)).map(entry => `${entry.kind} ${entry.path}`);
  return result;
}
