import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { gitBlobSha1 } from '../../src/core/pictures';
import { OverleafReader } from '../../src/core/overleaf';
import { ProjectStore, carrySelection } from '../../src/core/projectStore';
import { guardedWrite } from '../../src/core/guard';
import { SyncError } from '../../src/core/errors';
import { SyncService, ReviewWorkflow, remoteTexts } from '../../src/core/folderWorkflow';
import type { SeededProject } from './harness';

/** Writes only to the disposable projects that this CE run has just created. */
export async function syncProbe(url: string, cookie: string, projects: SeededProject[], tracking = false) {
  const results = [];
  for (const project of projects) {
    const root = await mkdtemp(join(tmpdir(), 'turnleaf-write-'));
    try {
      const reader = new OverleafReader(url, cookie); await reader.signIn();
      const paths = project.expectations.docs.map(d => d.path), i = await reader.inspect(project.projectId, paths);
      assert.equal(i.trackChanges, tracking, 'Track Changes state must agree with the seeded project setting');
      const state = new ProjectStore(root, url, project.projectId, paths), service = new SyncService(state, reader), workflow = new ReviewWorkflow(service);
      for (const [path, text] of Object.entries(remoteTexts(i))) await writeFile(join(root, path), text);
      await workflow.apply(await workflow.preparePull(), () => true);
      for (const doc of i.docs) {
        const anchor = doc.comments.find(c => c.state === 'placed' && c.ranges.some(r => r.length > 2));
        const range = anchor?.ranges.find(r => r.length > 2);
        const text = range ? tracking ? doc.text.slice(0, range.pos) + doc.text.slice(range.pos + range.length) : doc.text.slice(0, range.pos + 1) + 'CE revision ' + doc.text.slice(range.pos + 1) : doc.text + '\n% CE revision\n';
        await writeFile(join(root, doc.path), text);
      }
      const dry = await workflow.prepareSend(); assert.equal(dry.files.length, paths.length);
      const plan = await workflow.prepareSend(), pushed = await service.push(plan, () => true, () => {});
      assert.deepEqual(pushed.mismatches, []); assert.deepEqual(pushed.warnings, []);
      const history = (await state.history())[0]; assert.equal(history.outcome, 'success'); assert.equal(history.completed.length, paths.length);
      let checked = 0;
      for (const file of plan.files) {
        const doc = pushed.inspection.docs.find(d => d.path === file.doc.path)!;
        for (const predicted of file.mapping.comments) {
          const actual = doc.comments.find(c => c.threadId === predicted.threadId);
          if (!actual && predicted.state === 'anchor removed') continue;
          assert(actual, `Missing ${file.doc.path} thread ${predicted.threadId}`);
          assert.equal(actual.state, predicted.state, file.doc.path);
          assert.deepEqual(actual.ranges.filter(r => r.length), predicted.ranges.filter(r => r.length), file.doc.path);
          checked++;
        }
      }
      const incoming = await workflow.preparePull(); assert.equal(incoming.files.length, 0); assert.equal(incoming.comments.length, 0);
      const nothing = await workflow.prepareSend(); assert.equal(nothing.files.length, 0);
      const pictures = await pictureProbe(state, workflow, root, url, cookie, project.projectId, tracking ? 'ce-picture-tracked.png' : 'ce-picture.png');
      const other = projects.find(item => item !== project)?.projectId;
      const pictureSend = await pictureSendProbe(state, service, workflow, reader, root, url, cookie, project.projectId, other, tracking ? 'ce-picture-tracked.png' : 'ce-picture.png', tracking ? 'tracked' : 'plain');
      const created = await newFileProbe(reader, root, url, project.projectId, paths, tracking ? 'ce-new-tracked' : 'ce-new');
      results.push({ type: project.label, trackChanges: tracking, sentFiles: paths.length, anchorsCompared: checked, verifiedSteps: history.completed.length, gitRequired: false, verified: true, pullAfterPush: true, pictures, pictureSend, created });
    } finally { await rm(root, { recursive: true, force: true }); }
  }
  return results;
}

/**
 * A local-only file in a new folder: the selection grows with its state, Send
 * creates the folder and the file (read back by ID, content untracked), CE
 * refuses a second document of the same name, and Undo this send deletes the file
 * (the folder stays). Each pass uses its own folder, because the folder kept by
 * one pass's Undo already exists in the next pass on the same project.
 */
async function newFileProbe(reader: OverleafReader, root: string, url: string, projectId: string, paths: string[], folder: string) {
  const path = `${folder}/section.tex`, text = 'A section written locally.\n', all = [...paths, path];
  await mkdir(join(root, folder)); await writeFile(join(root, path), text);
  assert.equal(await carrySelection(root, url, projectId, paths, all), 'copied');
  const state = new ProjectStore(root, url, projectId, all), service = new SyncService(state, reader), workflow = new ReviewWorkflow(service);
  const plan = await workflow.prepareSend();
  assert.deepEqual(plan.files.map(file => [file.doc.path, file.create?.folders]), [[path, [folder]]]);
  const pushed = await service.push(plan, () => true, () => {});
  assert.deepEqual(pushed.mismatches, []);
  const doc = pushed.inspection.docs.find(item => item.path === path)!;
  assert.equal(doc.text, text); assert.equal(doc.changes.length, 0, 'the created content is not a suggestion');
  const tree = await reader.projectTree(projectId);
  assert.equal(tree.docs?.[path], doc.docId);
  // The duplicate-name refusal that Send relies on in the last moment.
  let refusal: number | undefined;
  try { await guardedWrite(state, { kind: 'createDoc', projectId, path, folderId: tree.folders[folder] }, () => true, async () => true, permit => reader.write(permit), () => {}); }
  catch (error) { refusal = error instanceof SyncError ? error.status : undefined; }
  assert(refusal !== undefined && refusal >= 400 && refusal < 500, `CE must refuse a second ${path} with HTTP 4xx (got ${refusal ?? 'success'})`);
  const [record] = await state.history(), undo = await workflow.prepareUndo(record.id);
  assert.deepEqual(undo.files.map(file => file.path), [path]);
  await service.push(undo.plan, () => true, () => {});
  const after = await reader.projectTree(projectId);
  assert(!after.docs?.[path] && after.folders[folder] === tree.folders[folder], 'Undo this send removes the created file and keeps its folder');
  assert.equal(await readFile(join(root, path), 'utf8'), text);
  return { createdFolder: true, createdFile: true, duplicateRefusal: refusal, undoRemovedFile: true, folderKept: true };
}

/** A small valid PNG, `size` pixels square in one grey level. */
function png(size: number, grey: number): Buffer {
  const crc = (bytes: Buffer) => { let c = ~0; for (const b of bytes) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; } return ~c >>> 0; };
  const chunk = (type: string, data: Buffer) => { const head = Buffer.from(type, 'latin1'), length = Buffer.alloc(4), sum = Buffer.alloc(4); length.writeUInt32BE(data.length); sum.writeUInt32BE(crc(Buffer.concat([head, data]))); return Buffer.concat([length, head, data, sum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 0;
  const rows = Buffer.concat(Array.from({ length: size }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(size, grey)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * A picture added on Overleaf, then replaced there by a coauthor: each time Get
 * latest lists it (new, then changed), downloads Overleaf's copy by hash and Apply
 * writes it; the replaced local copy is kept in Sync history. The upload stands in
 * for the coauthor, through CE's own upload route (the extension does not upload
 * in this step). Each pass uses its own file name.
 */
async function pictureProbe(state: ProjectStore, workflow: ReviewWorkflow, root: string, url: string, cookie: string, projectId: string, name: string) {
  const headers = { Cookie: `overleaf_session2=${cookie}` };
  const page = await (await fetch(new URL('/project', url), { headers, redirect: 'manual' })).text();
  const csrf = /<meta\s+name="ol-csrfToken"\s+content="([^"]+)"/.exec(page)?.[1];
  assert(csrf, 'the project list page gives a CSRF token');
  const tree = await new OverleafReader(url, cookie).projectTree(projectId);
  const upload = async (bytes: Buffer) => {
    const form = new FormData();
    form.append('name', name); form.append('qqfile', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), name);
    const response = await fetch(new URL(`/project/${projectId}/upload?folder_id=${tree.folders['']}`, url), { method: 'POST', headers: { ...headers, 'X-Csrf-Token': csrf, Accept: 'application/json' }, body: form });
    assert.equal(response.status, 200, `CE upload of ${name}`);
  };
  const rows = async () => { const plan = await workflow.preparePull(); return { plan, rows: (plan.pictures ?? []).map(p => [p.path, p.kind]) }; };
  const first = png(32, 40), second = png(48, 200);
  await upload(first);
  const added = await rows();
  assert.deepEqual(added.rows, [[name, 'new']]);
  assert.equal(added.plan.pictures![0].remote?.size, first.length);
  await workflow.apply(added.plan, () => true);
  assert.deepEqual(await readFile(join(root, name)), first);
  assert.equal((await state.pictures()).baseline[name]?.hash, gitBlobSha1(first));
  await upload(second);
  const changed = await rows();
  assert.deepEqual(changed.rows, [[name, 'changed']]);
  const before = (await state.historyUsage()).bytes;
  await workflow.apply(changed.plan, () => true);
  assert.deepEqual(await readFile(join(root, name)), second);
  assert.deepEqual(await state.getBytes(gitBlobSha1(first)), first, 'the replaced copy is kept in Sync history');
  const usage = (await state.historyUsage()).bytes;
  assert(usage >= before + first.length, 'Sync history counts the kept picture');
  const [record] = await state.history();
  assert.deepEqual(record.pictures?.map(p => [p.path, p.kind, p.before?.size, p.after?.size]), [[name, 'changed', first.length, second.length]]);
  assert.deepEqual((await rows()).rows, [], 'in sync after Apply');
  return { added: true, changed: true, applied: true, downloadVerified: true, keptInHistory: true, sizes: [first.length, second.length], maxUploadSize: changed.plan.inspection.maxUploadSize };
}

/** CE requests that stand in for a coauthor in the browser (they are not the extension's writes). */
async function coauthor(url: string, cookie: string) {
  const headers = { Cookie: `overleaf_session2=${cookie}` };
  const page = await (await fetch(new URL('/project', url), { headers, redirect: 'manual' })).text();
  const csrf = /<meta\s+name="ol-csrfToken"\s+content="([^"]+)"/.exec(page)?.[1];
  assert(csrf, 'the project list page gives a CSRF token');
  const write = async (method: string, path: string, body?: FormData | string) => {
    const response = await fetch(new URL(path, url), { method, headers: { ...headers, 'X-Csrf-Token': csrf, Accept: 'application/json', ...typeof body === 'string' && { 'Content-Type': 'application/json' } }, body });
    const text = await response.text();
    assert(response.status >= 200 && response.status < 300, `CE ${method} ${path.replace(/[0-9a-f]{24}/g, ':id')}: HTTP ${response.status}`);
    return text ? JSON.parse(text) : undefined;
  };
  return {
    upload: (projectId: string, folderId: string, name: string, bytes: Buffer) => {
      const form = new FormData(); form.append('name', name); form.append('qqfile', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), name);
      return write('POST', `/project/${projectId}/upload?folder_id=${folderId}`, form);
    },
    createDoc: (projectId: string, folderId: string, name: string) => write('POST', `/project/${projectId}/doc`, JSON.stringify({ name, parent_folder_id: folderId })),
    deleteFile: (projectId: string, fileId: string) => write('DELETE', `/project/${projectId}/file/${fileId}`),
    linkFile: (projectId: string, folderId: string, name: string, source: string, sourcePath: string) => write('POST', `/project/${projectId}/linked_file`, JSON.stringify({ name, parent_folder_id: folderId, provider: 'project_file', data: { source_project_id: source, source_entity_path: sourcePath } })),
  };
}

/**
 * Step nontext-files-send on CE: Send replaces a picture changed locally and creates
 * an added local-only one in a new folder, each read back by ID and hash; Send
 * refuses to upload over a name that became a text document or a linked file
 * since the summary; Undo this send puts the replaced bytes back and deletes the
 * created picture (its folder stays). `name` is the picture pictureProbe left
 * synchronized; `suffix` keeps the names of the two passes apart.
 */
async function pictureSendProbe(state: ProjectStore, service: SyncService, workflow: ReviewWorkflow, reader: OverleafReader, root: string, url: string, cookie: string, projectId: string, other: string | undefined, name: string, suffix: string) {
  const ce = await coauthor(url, cookie), tree = () => reader.projectTree(projectId), rootId = (await tree()).folders[''];
  const rows = async () => { const plan = await workflow.prepareSend(); return { plan, rows: (plan.pictures ?? []).map(p => [p.path, p.kind]) }; };
  const send = async (plan: Awaited<ReturnType<ReviewWorkflow['prepareSend']>>) => { const result = await service.push(plan, () => true, () => {}); assert.deepEqual(result.mismatches, []); return (await state.history())[0]; };
  const result: Record<string, unknown> = {};

  // 1. A replace, read back, then Undo this send puts the replaced bytes back.
  const second = await readFile(join(root, name)), third = png(64, 90);
  await writeFile(join(root, name), third);
  const replace = await rows();
  assert.deepEqual(replace.rows, [[name, 'replace']]);
  const before = (await tree()).fileRefs![name];
  const sent = await send(replace.plan);
  const after = (await tree()).fileRefs![name];
  assert.equal(after.hash, gitBlobSha1(third)); assert.notEqual(after.id, before.id, 'CE gives the upload a new file ID'); assert(!after.linked);
  assert.deepEqual(sent.sent!.files[name], { replacedHash: gitBlobSha1(second), sentHash: gitBlobSha1(third), fileId: after.id });
  assert.deepEqual(await state.getBytes(gitBlobSha1(second)), second, 'the replaced bytes are kept in Sync history');
  assert.deepEqual((await rows()).rows, [], 'nothing goes out after the Send');
  const undoReplace = await workflow.prepareUndo(sent.id);
  assert.deepEqual(undoReplace.plan.pictures!.map(p => [p.path, p.kind]), [[name, 'restore']]);
  await send(undoReplace.plan);
  const restored = (await tree()).fileRefs![name];
  assert.equal(restored.hash, gitBlobSha1(second), 'Undo this send puts the replaced bytes back');
  assert.deepEqual(await reader.downloadFile(projectId, name, { id: restored.id, hash: restored.hash! }), second);
  await writeFile(join(root, name), second);
  assert.deepEqual((await rows()).rows, []);
  result.replace = { readBack: true, newFileId: true, keptInHistory: true, undoRestored: true, sizes: [second.length, third.length] };

  // 2. A create in a new folder, read back, then Undo this send deletes it and keeps the folder.
  const folder = `ce-send-${suffix}`, created = `${folder}/figure.png`, bytes = png(24, 160);
  await mkdir(join(root, folder), { recursive: true }); await writeFile(join(root, created), bytes);
  assert.deepEqual((await rows()).rows, [], 'not added in Choose files: not sent');
  const picturesNow = await state.pictures(); await state.setPictures({ ...picturesNow, added: [...picturesNow.added ?? [], created] });
  const create = await rows();
  assert.deepEqual(create.rows, [[created, 'create']]); assert.deepEqual(create.plan.pictures![0].folders, [folder]);
  const made = await send(create.plan), createdTree = await tree(), file = createdTree.fileRefs![created];
  assert(createdTree.folders[folder], 'the folder was created first');
  assert.equal(file.hash, gitBlobSha1(bytes)); assert.equal(made.sent!.created![created].fileId, file.id);
  assert.deepEqual(made.completed, [`folder:${folder}`, `picture:${created}`]);
  const undoCreate = await workflow.prepareUndo(made.id);
  assert.deepEqual(undoCreate.plan.pictures!.map(p => [p.path, p.kind]), [[created, 'delete']]);
  await send(undoCreate.plan);
  const afterUndo = await tree();
  assert(!afterUndo.fileRefs?.[created] && !afterUndo.files.includes(created), 'Undo this send deletes the created picture');
  assert.equal(afterUndo.folders[folder], createdTree.folders[folder], 'its folder stays');
  assert.deepEqual((await state.pictures()).added?.includes(created), true, 'the local copy is only local again');
  result.create = { folderCreated: true, readBack: true, undoDeleted: true, folderKept: true };

  // 3. Refusal over a text document: planned as a create, the name becomes a document on Overleaf before Send.
  const clash = `${folder}/clash.png`;
  await writeFile(join(root, clash), png(16, 30));
  await state.setPictures({ ...await state.pictures(), added: [...(await state.pictures()).added ?? [], clash] });
  const clashPlan = await rows();
  assert.deepEqual(clashPlan.rows, [[created, 'create'], [clash, 'create']].sort((a, b) => a[0].localeCompare(b[0])));
  // Only the clash goes out in this plan.
  clashPlan.plan.pictures = clashPlan.plan.pictures!.filter(p => p.path === clash);
  const doc = await ce.createDoc(projectId, afterUndo.folders[folder], 'clash.png');
  let refusal = '';
  try { await service.push(clashPlan.plan, () => true, () => {}); } catch (error) { refusal = error instanceof SyncError ? `${error.code}: ${error.message}` : String(error); }
  assert.match(refusal, /^stale: .*clash\.png is a text document on Overleaf now/);
  const clashTree = await tree();
  assert.equal(clashTree.docs?.[clash], doc._id, 'the document is untouched'); assert(!clashTree.fileRefs?.[clash]);
  assert.match((await rows()).plan.pictures!.find(p => p.path === clash)!.note!, /text document of this name/, 'the summary now blocks it with the reason');
  result.textDocumentRefused = true;

  // 4. Refusal over a linked file: a plain picture is planned as a replace, then a coauthor makes the name a linked file.
  let linked: Record<string, unknown> | string = 'not tried: no second seeded project';
  if (other) {
    const source = (await reader.projectTree(other)).folders[''], linkName = `ce-link-${suffix}.png`;
    await ce.upload(other, source, 'ce-link-source.png', png(20, 70));
    await ce.upload(projectId, rootId, linkName, png(20, 110));
    await workflow.apply(await workflow.preparePull(), () => true);
    await writeFile(join(root, linkName), png(20, 120));
    const linkPlan = await rows();
    assert.deepEqual(linkPlan.rows.filter(row => row[0] === linkName), [[linkName, 'replace']]);
    linkPlan.plan.pictures = linkPlan.plan.pictures!.filter(p => p.path === linkName);
    await ce.deleteFile(projectId, (await tree()).fileRefs![linkName].id);
    await ce.linkFile(projectId, rootId, linkName, other, '/ce-link-source.png');
    const linkedBefore = (await tree()).fileRefs![linkName];
    assert(linkedBefore?.linked, 'CE made the name a linked file');
    let message = '';
    try { await service.push(linkPlan.plan, () => true, () => {}); } catch (error) { message = error instanceof SyncError ? `${error.code}: ${error.message}` : String(error); }
    const linkedAfter = (await tree()).fileRefs![linkName];
    assert.match(message, /^stale: .*is a linked file on Overleaf now/);
    assert(linkedAfter.linked && linkedAfter.id === linkedBefore.id && linkedAfter.hash === linkedBefore.hash, 'the linked file is untouched');
    linked = { refused: true, reason: message.replace(/^stale: /, ''), linkKept: true };
    await rm(join(root, linkName), { force: true });
  }
  result.linkedFileRefused = linked;
  // Leave nothing for the next probe to send: the local-only pictures leave the folder and the added list.
  await rm(join(root, folder), { recursive: true, force: true });
  await state.setPictures({ ...await state.pictures(), added: [] });
  return result;
}
