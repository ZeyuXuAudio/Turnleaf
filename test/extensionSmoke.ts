import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { writeFile, readFile } from 'node:fs/promises';
import { fixtureCookie, startFixtureServer } from './fixtureServer';
import type { TestApi } from '../src/extension/extension';
import { ProjectStore } from '../src/core/projectStore';
import { LocalReviewFiles, ThreadFile } from '../src/core/reviewFiles';

export async function run(): Promise<void> {
  const fixture = await startFixtureServer({ writable: true });
  const resultPath = process.env.TURNLEAF_SMOKE_RESULT!;
  try {
    const folder = vscode.workspace.workspaceFolders![0];
    const config = vscode.workspace.getConfiguration('turnleaf', folder.uri);
    await config.update('baseUrl', fixture.baseUrl, vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update('projectId', 'test-project', vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update('trackedFiles', ['main.tex', 'references.bib'], vscode.ConfigurationTarget.WorkspaceFolder);
    const extension = vscode.extensions.getExtension<TestApi>('zeyuxu.turnleaf');
    assert(extension);
    const api = await extension.activate();
    assert(api, 'Test API should be exposed only in an extension test host');
    const waitFor = async (predicate: () => boolean, label: string) => {
      for (let attempt = 0; attempt < 50 && !predicate(); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
      assert(predicate(), `${label}: ${JSON.stringify({ ...api.reviewSnapshot(), activeEditor: vscode.window.activeTextEditor?.document.uri.fsPath, groups: vscode.window.tabGroups.all.map(g => ({ column: g.viewColumn, active: g.isActive, tab: g.activeTab?.label })) })}`);
    };
    // The outgoing summary, once it reflects the current files and drafts.
    type Outgoing = NonNullable<ReturnType<typeof api.reviewView>['outgoing']>;
    const summary = async (ready: (o: Outgoing) => boolean, label: string): Promise<Outgoing> => {
      await waitFor(() => { const o = api.reviewView().outgoing; return api.summarySettled() && !!o && !o.busy && ready(o); }, label);
      return api.reviewView().outgoing!;
    };
    // A click on Send is ignored for a moment after the summary last changed.
    const send = async (command = 'send') => { await new Promise(resolve => setTimeout(resolve, 700)); await vscode.commands.executeCommand(`turnleaf.${command}`); };
    await api.signIn(fixtureCookie);
    assert.equal(await api.sessionStored(), true);
    const inspection = await api.inspect();
    assert.equal(inspection.docs.length, 2);
    const uri = await api.openFile('main.tex');
    const document = await vscode.workspace.openTextDocument(uri);
    assert.equal(document.getText(), 'Alpha βeta.\nSecond line.\n');
    assert.equal(document.uri.scheme, 'overleaf-inspection');
    await vscode.window.showTextDocument(document);
    // The UI typing command honors readonly virtual documents. TextEditor.edit is
    // an extension API that can bypass this UI restriction, so it is not a user-edit test.
    await vscode.commands.executeCommand('default:type', { text: 'must-not-be-written' });
    assert.equal(document.getText(), 'Alpha βeta.\nSecond line.\n');
    assert.equal((await api.openFile('main.tex')).toString(), uri.toString(), 'Repeated opening must reuse the inspection and its threads');
    const commands = await vscode.commands.getCommands(true);
    for (const command of ['signIn', 'linkProject', 'inspectProject', 'openInspectedFile', 'signOut']) assert(commands.includes(`turnleaf.${command}`));
    const settings = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, '.vscode/settings.json'));
    assert(!Buffer.from(settings).toString().includes(fixtureCookie));
    const contentWrites = fixture.requests.filter(request => {
      if (request.method === 'GET') return false;
      if (request.method !== 'POST' || !request.path.startsWith('/socket.io/1/xhr-polling/')) return true;
      if (['0::', '2::'].includes(request.packet ?? '')) return false;
      const match = /^5:\d+\+::(.+)$/.exec(request.packet ?? '');
      return !match || !['joinDoc', 'leaveDoc'].includes(JSON.parse(match[1]).name);
    }).length;
    assert.equal(contentWrites, 0, 'Inspection must send only reads and socket session control');
    const localText = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, 'main.tex'));
    assert.equal(Buffer.from(localText).toString(), 'Local text remains unchanged during inspection.\n');
    // Exercise the actual local review UI in an ordinary disposable folder.
    const state = new ProjectStore(folder.uri.fsPath, fixture.baseUrl, 'test-project', ['main.tex', 'references.bib']);
    // First sync: keep main.tex but replace references.bib with the Overleaf version.
    // Apply records both choices; the kept file is then listed as going out.
    const localReferences = 'Existing local bibliography before the first sync.\n';
    await writeFile(vscode.Uri.joinPath(folder.uri, 'references.bib').fsPath, localReferences);
    await vscode.commands.executeCommand('turnleaf.pull');
    assert.equal(api.reviewSnapshot().threadCount, 0, 'Incoming comments wait for Apply');
    const firstSync = api.reviewSnapshot().preview!;
    await vscode.commands.executeCommand('turnleaf.useRemoteVersion', { path: 'references.bib', preview: firstSync.id });
    assert.equal(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, 'references.bib'))).toString(), localReferences, 'Use Overleaf version only changes the preview');
    await vscode.commands.executeCommand('turnleaf.keepLocalVersion', { path: 'main.tex', preview: firstSync.id });
    let appliedSource: vscode.Uri | undefined;
    const sourceFocus = vscode.window.onDidChangeActiveTextEditor(editor => { if (editor?.document.uri.scheme === 'file') appliedSource = editor.document.uri; });
    try { await new Promise(resolve => setTimeout(resolve, 700)); await vscode.commands.executeCommand('turnleaf.applyReviewed', { preview: firstSync.id }); }
    finally { sourceFocus.dispose(); }
    assert.equal(appliedSource?.fsPath, vscode.Uri.joinPath(folder.uri, 'references.bib').fsPath, 'Apply leaves the virtual diff for the changed local source');
    assert.equal(api.reviewSnapshot().threadCount, 4); assert.equal(api.reviewThread('c2'), undefined, 'Resolved threads are hidden while Resolved is off'); assert(!existsSync(folder.uri.fsPath + '/.git'));
    assert.deepEqual((await summary(o => o.files.length === 1, 'The kept file is listed as going out')).files.map(file => file.path), ['main.tex']);
    assert.equal(api.reviewView().preview, undefined, 'No send preview: the summary is the review');
    assert.equal(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, 'main.tex'))).toString(), 'Local text remains unchanged during inspection.\n');
    assert.equal(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, 'references.bib'))).toString(), inspection.docs.find(doc => doc.path === 'references.bib')!.text, 'Apply writes the chosen Overleaf version');
    await vscode.commands.executeCommand('turnleaf.pull');
    assert.equal(api.reviewSnapshot().preview?.files, 0);
    assert(!api.reviewSnapshot().preview?.stale);
    assert.match(api.reviewSnapshot().preview?.complete ?? '', /up to date/);
    await vscode.commands.executeCommand('turnleaf.cancelPreview');
    for (const doc of inspection.docs) await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(folder.uri, doc.path), Buffer.from(doc.text));
    await waitFor(() => inspection.docs.every(doc => {
      const open = vscode.workspace.textDocuments.find(open => open.uri.toString() === vscode.Uri.joinPath(folder.uri, doc.path).toString());
      return !open || open.getText() === doc.text;
    }), 'Restored fixture files reload before editor edits');
    // Linked workspaces get clear markers once. Restore opts out durably.
    const workbench = vscode.workspace.getConfiguration('workbench');
    assert.equal(workbench.get('productIconTheme'), 'turnleaf-outline');
    assert.equal(api.reviewView().outlineMarkers, true);
    await vscode.commands.executeCommand('turnleaf.toggleOutlineMarkers');
    assert.equal(vscode.workspace.getConfiguration('workbench').inspect('productIconTheme')?.workspaceValue, undefined);
    await api.restoreLocal();
    await vscode.commands.executeCommand('turnleaf.refreshComments');
    assert.notEqual(vscode.workspace.getConfiguration('workbench').get('productIconTheme'), 'turnleaf-outline', 'Restoring the workspace must not undo the appearance opt-out');
    // Manual styling is also scoped, repairable and reversible.
    await workbench.update('productIconTheme', 'Default', vscode.ConfigurationTarget.Workspace);
    const customColors = { 'editorGutter.commentGlyphForeground': '#123456', 'editor.selectionBackground': '#345678' };
    await workbench.update('colorCustomizations', customColors, vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand('turnleaf.toggleOutlineMarkers', { value: 'workspace' });
    assert.equal(vscode.workspace.getConfiguration('workbench').get('productIconTheme'), 'turnleaf-outline');
    assert.equal(vscode.workspace.getConfiguration('workbench').get<Record<string, string>>('colorCustomizations')?.['editorGutter.commentRangeForeground'], '#00000000');
    const appliedColors = vscode.workspace.getConfiguration('workbench').get<Record<string, string>>('colorCustomizations')!;
    await workbench.update('colorCustomizations', { ...appliedColors, 'editorGutter.commentRangeForeground': '#888888' }, vscode.ConfigurationTarget.Workspace);
    assert.equal(api.reviewView().outlineMarkers, false, 'An opaque background offers a marker repair');
    await vscode.commands.executeCommand('turnleaf.toggleOutlineMarkers', { value: 'workspace' });
    assert.equal(api.reviewView().outlineMarkers, true, 'Repair restores contrast without losing the original settings');
    await vscode.commands.executeCommand('turnleaf.toggleOutlineMarkers');
    assert.equal(vscode.workspace.getConfiguration('workbench').get('productIconTheme'), 'Default');
    assert.deepEqual(vscode.workspace.getConfiguration('workbench').inspect('colorCustomizations')?.workspaceValue, customColors);
    await workbench.update('productIconTheme', 'turnleaf-outline', vscode.ConfigurationTarget.Workspace);
    assert.equal(api.reviewView().outlineMarkers, false, 'Selecting only the font theme still needs gutter colors');
    await vscode.commands.executeCommand('turnleaf.toggleOutlineMarkers', { value: 'workspace' });
    assert.equal(api.reviewView().outlineMarkers, true);
    await vscode.commands.executeCommand('turnleaf.toggleOutlineMarkers');
    assert.deepEqual(vscode.workspace.getConfiguration('workbench').inspect('colorCustomizations')?.workspaceValue, customColors);
    await workbench.update('productIconTheme', 'Default', vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand('turnleaf.markAddressed', 'c1');
    const review = await state.reviews();
    assert.equal(review.c1.status, 'addressed'); assert.equal(review.c1.sha, (await state.read()).revision);
    await vscode.commands.executeCommand('turnleaf.exportReviewLog');
    const log = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, 'docs/overleaf_review_log.md'))).toString(); assert.match(log, /addressed in/); assert.match(log, /Unknown positions/);
    await vscode.commands.executeCommand('turnleaf.showReviewPanel'); assert.equal(api.reviewSnapshot().panel, true);
    await vscode.commands.executeCommand('turnleaf.openThread', 'c1');
    let editor = await vscode.window.showTextDocument(vscode.Uri.joinPath(folder.uri, 'main.tex'), { viewColumn: vscode.ViewColumn.One, preserveFocus: false, preview: false });
    await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
    await waitFor(() => vscode.window.activeTextEditor?.document.uri.toString() === editor.document.uri.toString(), 'Main source editor active');
    const initialGlyphLines = api.reviewCommentingRanges(editor.document).map(range => range.end.line);
    assert(initialGlyphLines.includes(api.reviewThread('c1')!.range.end.line), 'Existing comment glyphs have a native click-enabled range');
    assert(api.reviewCommentingRanges(editor.document).every(range => range.isEmpty), 'Only existing glyph lines support the native commenting action');
    assert(await editor.edit(e => e.insert(new vscode.Position(0, 0), 'Inserted locally.\n')));
    await waitFor(() => api.reviewSnapshot().labels.includes('moved'), 'Insertion shifts anchors');
    assert(api.reviewCommentingRanges(editor.document).some(range => range.end.line === api.reviewThread('c1')!.range.end.line), 'Click ranges follow moved glyphs');
    await vscode.commands.executeCommand('undo');
    await waitFor(() => editor.document.getText() === inspection.docs[0].text && !api.reviewSnapshot().labels.includes('moved'), 'Undo insertion');
    assert(await editor.edit(e => e.delete(new vscode.Range(0, 0, 0, 5))));
    await waitFor(() => api.reviewSnapshot().labels.includes('deleted locally'), 'Deletion marks the removed anchor');
    await vscode.commands.executeCommand('undo');
    await waitFor(() => editor.document.getText() === inspection.docs[0].text && !api.reviewSnapshot().labels.includes('deleted locally'), 'Undo deletion restores anchor');
    assert.equal(editor.document.getText(), inspection.docs[0].text); assert(!api.reviewSnapshot().labels.includes('deleted locally'));
    // With word wrap on, a marker goes to the blank line under the commented line; without one, there is none until the comment is opened.
    const c1Line = api.reviewThread('c1')!.range.end.line, blankBelow = () => c1Line + 1 < editor.document.lineCount && !editor.document.lineAt(c1Line + 1).text.trim();
    await vscode.commands.executeCommand('turnleaf.openThread', 'legacy');
    await vscode.workspace.getConfiguration('editor').update('wordWrap', 'on', vscode.ConfigurationTarget.Global);
    const wrapped = await vscode.window.showTextDocument(editor.document, vscode.ViewColumn.One);
    if (blankBelow()) await waitFor(() => api.reviewThread('c1')?.range.end.line === c1Line + 1, 'The marker moves to the blank line below');
    else {
      await waitFor(() => !api.reviewThread('c1'), 'No marker without a blank line below');
      assert(await wrapped.edit(e => e.insert(new vscode.Position(c1Line + 1, 0), '\n')));
      await waitFor(() => api.reviewThread('c1')?.range.end.line === c1Line + 1, 'An added blank line takes the marker');
      await vscode.commands.executeCommand('turnleaf.toggleHighlights');
      await new Promise(resolve => setTimeout(resolve, 300));
      assert.equal(api.reviewThread('c1')?.range.end.line, c1Line + 1, 'The marker stays below with highlights off');
      await vscode.commands.executeCommand('turnleaf.toggleHighlights');
      assert(await wrapped.edit(e => e.delete(new vscode.Range(c1Line + 1, 0, c1Line + 2, 0))));
      await waitFor(() => wrapped.document.getText() === inspection.docs[0].text && !api.reviewThread('c1'), 'Removing the blank line removes the marker again');
      await vscode.commands.executeCommand('turnleaf.openThread', 'c1');
      await waitFor(() => api.reviewThread('c1')?.range.end.line === c1Line && api.reviewThread('c1')?.collapsibleState === vscode.CommentThreadCollapsibleState.Expanded, 'Opening the comment gives it its thread on the commented line');
    }
    await vscode.workspace.getConfiguration('editor').update('wordWrap', undefined, vscode.ConfigurationTarget.Global);
    await waitFor(() => api.reviewThread('c1')?.range.end.line === c1Line, 'With word wrap off the marker is on the commented line');
    editor = await vscode.window.showTextDocument(editor.document, { viewColumn: vscode.ViewColumn.One, preserveFocus: false, preview: false });
    await vscode.window.showTextDocument(vscode.Uri.joinPath(folder.uri, 'references.bib'), { viewColumn: vscode.ViewColumn.Two });
    await vscode.commands.executeCommand('workbench.action.focusSecondEditorGroup');
    await waitFor(() => api.reviewSnapshot().activePath === 'references.bib', 'Second source editor active');
    await vscode.window.showTextDocument(vscode.Uri.joinPath(folder.uri, 'main.tex'), { viewColumn: vscode.ViewColumn.One, preserveFocus: false, preview: false });
    await waitFor(() => api.reviewSnapshot().activePath === 'main.tex', 'First source editor active');
    assert(!api.reviewSnapshot().labels.includes('moved'));
    // Finish the split-following check before testing Undo. A background Cursor
    // window can retain DOM focus in the old split even after its active tab moves.
    const bibliographyTabs = vscode.window.tabGroups.all.flatMap(g => g.tabs).filter(t => t.input instanceof vscode.TabInputText && t.input.uri.fsPath.endsWith('/references.bib'));
    await vscode.window.tabGroups.close(bibliographyTabs);
    await vscode.window.showTextDocument(editor.document, { viewColumn: vscode.ViewColumn.One, preserveFocus: false, preview: false });
    const activeSource = vscode.window.visibleTextEditors.find(e => e.document.uri.fsPath === editor.document.uri.fsPath && e.viewColumn === vscode.ViewColumn.One)!;
    assert(activeSource, 'The selected source is visible in the first group');
    assert(await activeSource.edit(edit => edit.insert(new vscode.Position(0, 0), 'x'.repeat(210_000) + '\n')));
    await waitFor(() => api.reviewSnapshot().labels.includes('moved'), 'The bundled worker maps a large edit');
    await vscode.commands.executeCommand('undo');
    await waitFor(() => activeSource.document.getText() === inspection.docs[0].text && !api.reviewSnapshot().labels.includes('moved'), 'Undo large edit');
    assert.equal(activeSource.document.getText(), inspection.docs[0].text);
    // A complete-buffer replacement can move native glyphs even when the
    // recomputed anchor has the same coordinates. Keep the original thread and
    // editing comment while publishing a fresh range update to the workbench.
    assert(await editor.edit(e => e.insert(new vscode.Position(0, 0), '\n\n\n')));
    await waitFor(() => api.reviewThread('c1')!.range.start.line === 3, 'Prepare a non-first-line comment for whole-buffer replacement');
    const bulkThread = api.reviewThread('c1')!, bulkRange = bulkThread.range;
    const bulkComment = bulkThread.comments[0]; await vscode.commands.executeCommand('turnleaf.editComment', bulkComment);
    const replacedText = editor.document.getText() + 'Whole-buffer replacement.\n';
    assert(await editor.edit(e => e.replace(new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(editor.document.getText().length)), replacedText)));
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(api.reviewThread('c1'), bulkThread, 'Bulk edits retain thread identity');
    assert(bulkThread.range.isEqual(bulkRange), 'Stable anchors remain at their mapped coordinates');
    assert.equal(bulkThread.comments[0], bulkComment, 'Bulk edits retain comment edit drafts');
    assert.equal(bulkComment.mode, vscode.CommentMode.Editing);
    await vscode.commands.executeCommand('turnleaf.cancelCommentEdit', bulkComment);
    assert(await editor.edit(e => e.replace(new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(editor.document.getText().length)), inspection.docs[0].text)));
    await editor.document.save();
    // Closing the live connection sends its own disconnect; any read or new connection still counts.
    const contacts = () => fixture.requests.filter(request => !request.path.includes('/socket.io/1/xhr-polling/')).length;
    const reads = contacts(); await api.restoreLocal();
    assert.equal(contacts(), reads, 'Opening cached review must not contact Overleaf');
    assert.equal(api.reviewSnapshot().threadCount, 4); assert.equal(api.reviewSnapshot().cached, true); assert.match(api.reviewSnapshot().state, /stale/);
    // Exercise the production sidebar, native comment actions, and native diff tabs.
    await config.update('allowWrites', true, vscode.ConfigurationTarget.WorkspaceFolder);
    await api.refreshLocal();
    const nativeThread = api.reviewThread('c1')!;
    assert(nativeThread.canReply); const own = nativeThread.comments[0];
    assert.equal(own.contextValue, 'overleaf.ownMessage');
    await vscode.commands.executeCommand('turnleaf.editComment', own);
    assert.equal(nativeThread.comments[0].mode, vscode.CommentMode.Editing);
    nativeThread.comments[0].body = 'A draft that must survive a remote refresh.';
    await api.refreshLocal();
    assert.equal(api.reviewThread('c1'), nativeThread, 'Refresh preserves the native thread');
    assert.equal(nativeThread.comments[0].body, 'A draft that must survive a remote refresh.');
    await vscode.commands.executeCommand('turnleaf.saveComment', nativeThread.comments[0]);
    assert.notEqual(fixture.threads.c1.messages[0].content, 'A draft that must survive a remote refresh.', 'Saving a draft does not publish it');
    await vscode.commands.executeCommand('turnleaf.reply', { thread: nativeThread, text: 'Native inline reply.' });
    assert.notEqual(fixture.threads.c1.messages.at(-1).content, 'Native inline reply.');
    await vscode.commands.executeCommand('turnleaf.push');
    await waitFor(() => api.reviewSnapshot().sidebar, 'The former Review & send command opens the sidebar summary');
    assert.equal(fixture.threads.c1.messages.at(-1).content === 'Native inline reply.', false, 'Opening the summary sends nothing');
    assert.equal((await summary(o => o.comments.length === 2, 'The edit and the reply are listed as going out')).files.length, 0);
    await send();
    assert.match(api.reviewSnapshot().state, /Sent and verified/);
    assert(api.reviewView().undoLatest, 'A verified send offers Undo');
    assert.equal(fixture.threads.c1.messages[0].content, 'A draft that must survive a remote refresh.');
    assert.equal(fixture.threads.c1.messages.at(-1).content, 'Native inline reply.');
    // Enable the file interface, then write as an external editor or agent does.
    await vscode.commands.executeCommand('turnleaf.openReviewFiles');
    const reviewFiles = new LocalReviewFiles(state), threadFilePath = await reviewFiles.path('threads/c1.json');
    assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, await reviewFiles.path());
    const jsonThread: ThreadFile = JSON.parse(await readFile(threadFilePath, 'utf8'));
    jsonThread.localEdits = [{ id: 'editor-json-reply', action: 'reply', text: 'Reply saved directly in JSON.' }];
    await writeFile(threadFilePath, JSON.stringify(jsonThread, null, 2) + '\n');
    await waitFor(() => api.reviewView().drafts?.some(d => d.id === 'editor-json-reply') === true, 'Filesystem watcher imports JSON drafts');
    assert.notEqual(fixture.threads.c1.messages.at(-1).content, 'Reply saved directly in JSON.');
    assert.equal((await summary(o => o.comments.length === 1, 'The JSON reply is listed as going out')).comments[0].after?.messages.at(-1)?.text, 'Reply saved directly in JSON.');
    const jsonDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(threadFilePath));
    const jsonEditor = await vscode.window.showTextDocument(jsonDocument, { preview: false });
    assert(await jsonEditor.edit(edit => edit.insert(jsonDocument.positionAt(jsonDocument.getText().length), ' ')));
    await waitFor(() => !!api.reviewView().outgoing?.unsaved?.includes('comment JSON'), 'Unsaved comment JSON is named in the summary');
    await send().catch(() => {});
    assert.notEqual(fixture.threads.c1.messages.at(-1).content, 'Reply saved directly in JSON.', 'Send refuses while a selected file has unsaved edits');
    await jsonDocument.save();
    await summary(o => !o.unsaved && o.comments.length === 1, 'The saved JSON reply is in the summary');
    await send();
    assert.equal(fixture.threads.c1.messages.at(-1).content, 'Reply saved directly in JSON.');
    assert.deepEqual(JSON.parse(await readFile(threadFilePath, 'utf8')).localEdits, []);
    assert.match(await readFile(await reviewFiles.path(), 'utf8'), /Reply saved directly in JSON/);
    let source = await vscode.window.showTextDocument(vscode.Uri.joinPath(folder.uri, 'main.tex'));
    assert(await source.edit(edit => edit.insert(source.document.positionAt(source.document.getText().length), '\nSaved preview revision.\n'))); await source.document.save();
    const firstEdit = await summary(o => o.files.length === 1, 'The saved edit is listed as going out');
    assert.equal(api.reviewSnapshot().preview, undefined);
    await vscode.commands.executeCommand('turnleaf.openOutgoingDiff', { path: 'main.tex' });
    assert(vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputTextDiff)), 'Native diff is open');
    assert.equal(api.reviewView().activePath, 'main.tex', 'Diff tab keeps source comment context');
    assert(api.reviewView().rows.some(row => row.path === 'main.tex'), 'Comments remain visible beside the diff');
    assert.equal(api.reviewView().outgoing?.selectedPath, 'main.tex');
    source = await vscode.window.showTextDocument(source.document);
    assert(await source.edit(edit => edit.insert(source.document.positionAt(source.document.getText().length), 'Another saved revision.\n')));
    await waitFor(() => !!api.reviewView().outgoing?.unsaved?.includes('main.tex'), 'An unsaved selected buffer is named in the summary');
    const remoteBefore = fixture.replies.modern[0].content;
    await send().catch(() => {});
    assert.equal(fixture.replies.modern[0].content, remoteBefore, 'Send refuses while a selected file has unsaved edits');
    await source.document.save();
    await summary(o => !o.unsaved && o.files.length === 1 && o.files[0].added > firstEdit.files[0].added, 'The summary follows the saved file');
    await send();
    assert.match(api.reviewSnapshot().state, /Sent and verified/);
    assert.match(fixture.replies.modern[0].content, /Saved preview revision/);
    // Undo this send takes the edit back from Overleaf only; the local file keeps it and it goes out again.
    const sentRecord = api.reviewView().undoLatest!;
    assert(sentRecord, 'A verified send offers Undo');
    await vscode.commands.executeCommand('turnleaf.undoSend', { value: sentRecord });
    assert.deepEqual(api.reviewView().undo?.files.map(file => file.path), ['main.tex'], 'The undo summary lists what is taken back');
    await send('sendUndo');
    assert.doesNotMatch(fixture.replies.modern[0].content, /Saved preview revision/, 'Undo takes the edit back from Overleaf');
    assert.match(source.document.getText(), /Saved preview revision/, 'Undo leaves the local file as it is');
    assert.equal(api.reviewView().undo, undefined);
    assert.equal((await state.history())[0].undoOf, sentRecord);
    await summary(o => o.files.length === 1, 'The edit is listed as going out again');
    await send();
    assert.match(fixture.replies.modern[0].content, /Saved preview revision/, 'Send puts the edit back');
    const beforeRemote = source.document.getText(); fixture.replies.modern[0].content += '\nRemote incoming revision.\n'; fixture.replies.modern[1]++;
    await vscode.commands.executeCommand('turnleaf.pull');
    assert.equal(source.document.getText(), beforeRemote, 'Get latest is preview only');
    fixture.replies.modern[0].content += 'A second remote edit.\n'; fixture.replies.modern[1]++;
    await vscode.commands.executeCommand('turnleaf.checkRemote');
    // Regular checks keep each thread's last place and text, not only explicit refreshes.
    await state.update(data => { data.anchors = {}; });
    await vscode.commands.executeCommand('turnleaf.checkRemote');
    assert(Object.keys((await state.read()).anchors).length, 'A regular check saves comment positions');
    assert(api.reviewSnapshot().preview?.stale, 'Freshness check invalidates an outdated incoming preview');
    assert.equal(source.document.getText(), beforeRemote, 'Remote status checking does not apply updates');
    await vscode.commands.executeCommand('turnleaf.pull');
    await new Promise(resolve => setTimeout(resolve, 700));
    await vscode.commands.executeCommand('turnleaf.applyReviewed');
    assert.equal(api.reviewView().preview, undefined, 'Successful Apply clears the incoming comparison without another Get latest');
    await waitFor(() => source.document.getText().includes('Remote incoming revision'), 'Applied files reload in the source editor');
    assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), source.document.uri.toString(), 'Apply returns to the real source for build and PDF navigation');
    await summary(o => o.files.length === 0 && o.comments.length === 0 && !o.blocked, 'The applied remote version leaves nothing to send');
    source = await vscode.window.showTextDocument(source.document);
    source.selection = new vscode.Selection(0, 0, 0, 5);
    await vscode.commands.executeCommand('turnleaf.newComment', { text: 'A new selected comment.' });
    const newDraft = (await state.read()).pending.find(draft => draft.kind === 'createThread')!;
    assert(newDraft); assert.equal(api.reviewThread(newDraft.threadId)?.collapsibleState, vscode.CommentThreadCollapsibleState.Expanded);
    assert(!fixture.threads[newDraft.threadId]);
    await vscode.commands.executeCommand('turnleaf.reply', { thread: newDraft.threadId, text: 'A dependent pending reply.' });
    fixture.replies.modern[0].content += 'Incoming edit after drafting a comment.\n'; fixture.replies.modern[1]++;
    await vscode.commands.executeCommand('turnleaf.pull');
    await new Promise(resolve => setTimeout(resolve, 700)); await vscode.commands.executeCommand('turnleaf.applyReviewed');
    assert.equal(api.reviewView().preview, undefined, 'Applying incoming comments also clears the completed comparison');
    assert.equal(api.reviewView().drafts?.length, 2, 'Unsent local comments remain after the incoming comparison clears');
    await waitFor(() => source.document.getText().includes('Incoming edit after drafting'), 'Incoming edit reloads without publishing the new comment');
    const followed = async () => (await state.read()).pending.find(draft => draft.id === newDraft.id)?.anchor?.source === source.document.getText();
    for (let attempt = 0; attempt < 50 && !await followed(); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
    assert(await followed(), 'The new comment follows its unchanged text through the incoming edit');
    assert.equal(api.reviewView().drafts?.find(draft => draft.id === newDraft.id)?.unplaced, undefined, 'A comment that followed its text needs no new selection');
    // Editing the selected text itself asks for a new selection; restoring it lets the comment follow again.
    source = await vscode.window.showTextDocument(source.document);
    const selected = source.document.getText(new vscode.Range(0, 0, 0, 5));
    await source.edit(edit => edit.replace(new vscode.Range(0, 0, 0, 5), 'QQQQQ')); await source.document.save();
    await waitFor(() => api.reviewView().drafts?.find(draft => draft.id === newDraft.id)?.unplaced === true, 'Editing the selected text marks the new comment as needing a new selection');
    await source.edit(edit => edit.replace(new vscode.Range(0, 0, 0, 5), selected)); await source.document.save();
    await waitFor(() => !api.reviewView().drafts?.find(draft => draft.id === newDraft.id)?.unplaced, 'Restoring the text clears the request for a new selection');
    source = await vscode.window.showTextDocument(source.document);
    source.selection = new vscode.Selection(0, 0, 0, 5);
    await vscode.commands.executeCommand('turnleaf.reattachDraft', { value: newDraft.id });
    const reattached = (await state.read()).pending;
    assert.equal(reattached.length, 2, 'Updating the anchor retains the draft and its dependent reply');
    assert.equal(reattached[0].id, newDraft.id); assert.equal(reattached[0].threadId, newDraft.threadId);
    assert.equal(reattached[0].anchor?.source, source.document.getText());
    assert(!fixture.threads[newDraft.threadId], 'Reattaching remains local until Send');
    await summary(o => o.comments.length === 2 && !o.blocked, 'The new comment and its reply are listed as going out');
    await send();
    assert.equal(fixture.threads[newDraft.threadId].messages[0].content, 'A new selected comment.');
    assert.equal(fixture.threads[newDraft.threadId].messages[1].content, 'A dependent pending reply.');
    // Conflicting scratch copies must not trigger source-file build-on-save.
    source = await vscode.window.showTextDocument(source.document);
    const overlapBase = source.document.getText();
    assert(await source.edit(edit => edit.replace(new vscode.Range(0, 0, 0, 5), 'LOCAL'))); await source.document.save();
    const chosenResolution = source.document.getText();
    fixture.replies.modern[0].content = 'OTHER' + overlapBase.slice(5); fixture.replies.modern[1]++;
    await vscode.commands.executeCommand('turnleaf.pull');
    const conflictPreview = api.reviewView().preview!;
    assert(conflictPreview.files.some(file => file.conflict), 'Competing edits require an explicit resolution');
    await vscode.commands.executeCommand('turnleaf.resolveConflict', { path: 'main.tex', preview: conflictPreview.id });
    const scratch = vscode.workspace.textDocuments.find(doc => doc.uri.fsPath.endsWith('/main.tex.resolution.txt'))!;
    assert(scratch); assert.equal(scratch.languageId, 'plaintext', 'Resolution scratch is not treated as a LaTeX source');
    const scratchEditor = vscode.window.visibleTextEditors.find(editor => editor.document === scratch)!;
    assert(await scratchEditor.edit(edit => edit.replace(new vscode.Range(scratch.positionAt(0), scratch.positionAt(scratch.getText().length)), chosenResolution))); await scratch.save();
    await vscode.commands.executeCommand('turnleaf.useResolution', { path: 'main.tex', preview: conflictPreview.id });
    assert(!api.reviewView().preview!.files.some(file => file.conflict));
    await new Promise(resolve => setTimeout(resolve, 700)); await vscode.commands.executeCommand('turnleaf.applyReviewed');
    assert.equal(source.document.getText(), chosenResolution, 'Applying the chosen resolution preserves the local bytes');
    // A reviewer's suggestion: Accept, then Reject replaces it; Send removes the insertion on Overleaf and locally.
    const suggested = fixture.replies.modern[0];
    suggested.trackedChanges.push({ range: { pos: suggested.content.length, length: 10 }, tracking: { type: 'insert', userId: 'reviewer', ts: '2026-10-30T10:00:00.000Z' } });
    suggested.content += ' SUGGESTED'; fixture.replies.modern[1]++;
    await vscode.commands.executeCommand('turnleaf.pull');
    await new Promise(resolve => setTimeout(resolve, 700)); await vscode.commands.executeCommand('turnleaf.applyReviewed');
    await waitFor(() => source.document.getText().endsWith(' SUGGESTED') && !!api.reviewView().suggestionRows?.some(row => row.text === ' SUGGESTED'), 'The suggested insertion arrives with a card');
    const suggestion = api.reviewView().suggestionRows!.find(row => row.text === ' SUGGESTED')!;
    await vscode.commands.executeCommand('turnleaf.acceptChange', { path: 'main.tex', value: suggestion.id });
    await vscode.commands.executeCommand('turnleaf.rejectChange', { path: 'main.tex', value: suggestion.id });
    assert.deepEqual((await state.read()).pending.map(draft => draft.kind), ['rejectChange'], 'A second decision replaces the first');
    assert.equal(api.reviewView().suggestionRows?.find(row => row.text === ' SUGGESTED')?.decision, 'reject');
    assert(source.document.getText().endsWith(' SUGGESTED'), 'Nothing changes before Send');
    assert.equal((await summary(o => o.comments.length === 1 && !o.blocked, 'The decision is listed as going out')).comments[0].label, 'Reject suggestion');
    await send();
    assert.match(api.reviewSnapshot().state, /Sent and verified/);
    await waitFor(() => !source.document.getText().includes('SUGGESTED'), 'The rejected insertion leaves the open editor');
    assert(!fixture.replies.modern[0].content.includes('SUGGESTED')); assert.equal((await state.read()).pending.length, 0);
    // Redraws that overlap keep every comment thread alive.
    const threadsBefore = api.reviewSnapshot().threadCount;
    await Promise.all([api.refreshLocal(), api.refreshLocal(), vscode.commands.executeCommand('turnleaf.toggleHighlights'), api.refreshLocal()]);
    assert.equal(api.reviewSnapshot().disposedInUse, 0, 'No disposed thread stays in use'); assert.equal(api.reviewSnapshot().threadCount, threadsBefore);
    // Highlights off hides comment and suggestion decorations and closes open comment windows; the switch remembers its state.
    assert.equal(api.reviewSnapshot().highlights, false);
    assert.deepEqual(api.reviewSnapshot().decorations, { comments: 0, insertions: 0, deletions: 0 }, 'Highlights off clears comment and suggestion decorations');
    assert.equal(api.reviewThread('c1')?.collapsibleState, vscode.CommentThreadCollapsibleState.Collapsed);
    await vscode.commands.executeCommand('turnleaf.toggleHighlights'); assert.equal(api.reviewSnapshot().highlights, true);
    const defaultDecorations = api.reviewSnapshot().decorations;
    // By now the conflict resolution has replaced the open comments' text (their anchors sit in a
    // suggested deletion or are gone), so only text still in the editor is highlighted; the resolved c2 stays hidden.
    const openHighlights = api.reviewView().rows.filter(row => row.path === 'main.tex' && !row.thread.resolved).flatMap(row => row.anchor.ranges).filter(range => range.length > 0).length;
    assert.equal(defaultDecorations.comments, openHighlights, 'Highlights on shows comment highlights for the open comments that still have text');
    assert(defaultDecorations.insertions > 0 && defaultDecorations.deletions > 0, 'Highlights on shows suggestion decorations');
    // Review filter chips control both editor gutter markers and highlights.
    assert.equal(api.reviewThread('c2'), undefined, 'Resolved thread stays hidden while Resolved is off');
    await vscode.commands.executeCommand('turnleaf.toggleReviewFilter', { value: 'resolved' });
    assert(api.reviewThread('c2'), 'Turning Resolved on shows resolved gutter markers');
    assert(api.reviewSnapshot().decorations.comments > defaultDecorations.comments, 'Turning Resolved on highlights resolved comments');
    await vscode.commands.executeCommand('turnleaf.toggleReviewFilter', { value: 'resolved' });
    assert.equal(api.reviewThread('c2'), undefined, 'Turning Resolved off hides resolved gutter markers again');
    assert.equal(api.reviewSnapshot().decorations.comments, defaultDecorations.comments);
    await vscode.commands.executeCommand('turnleaf.toggleReviewFilter', { value: 'suggestions' });
    assert.equal(api.reviewSnapshot().decorations.insertions, 0, 'Turning Suggestions off hides suggested insertions');
    assert.equal(api.reviewSnapshot().decorations.deletions, 0, 'Turning Suggestions off hides suggested deletions');
    assert.equal(api.reviewSnapshot().decorations.comments, defaultDecorations.comments, 'Comment highlights stay visible while Open is on');
    await vscode.commands.executeCommand('turnleaf.toggleReviewFilter', { value: 'suggestions' });
    assert.deepEqual(api.reviewSnapshot().decorations, defaultDecorations);
    // Opening a filtered-out thread still reveals it until another thread opens or its filter changes.
    await vscode.commands.executeCommand('turnleaf.openThread', 'c2');
    assert(api.reviewThread('c2'), 'Opening a resolved thread reveals it even while Resolved is off');
    // Opening a thread neither waits for nor is refused by a running Overleaf operation.
    await Promise.all([vscode.commands.executeCommand('turnleaf.checkRemote'), vscode.commands.executeCommand('turnleaf.openThread', 'legacy')]);
    assert.equal(api.reviewView().selectedThread, 'legacy', 'Open thread ran while the check was running');
    // Accept all, then the same again undoes all.
    const mainSuggestions = () => api.reviewView().suggestionRows?.filter(row => row.path === 'main.tex').length ?? 0;
    source = await vscode.window.showTextDocument(source.document); const suggestionsBefore = mainSuggestions();
    const bulkDoc = fixture.replies.modern[0], bulkStart = bulkDoc.content.length;
    bulkDoc.trackedChanges.push({ range: { pos: bulkStart, length: 4 }, tracking: { type: 'insert', userId: 'reviewer', ts: '2026-10-30T11:00:00.000Z' } }, { range: { pos: bulkStart + 4, length: 4 }, tracking: { type: 'insert', userId: 'reviewer', ts: '2026-10-30T11:00:01.000Z' } });
    bulkDoc.content += ' AAA BBB'; fixture.replies.modern[1]++;
    await vscode.commands.executeCommand('turnleaf.pull');
    await new Promise(resolve => setTimeout(resolve, 700)); await vscode.commands.executeCommand('turnleaf.applyReviewed');
    source = await vscode.window.showTextDocument(source.document);
    await waitFor(() => mainSuggestions() === suggestionsBefore + 2, 'Two more suggestions arrive');
    await vscode.commands.executeCommand('turnleaf.acceptAllChanges', { path: 'main.tex' });
    const accepted = (await state.read()).pending;
    assert.equal(accepted.length, suggestionsBefore + 2); assert(accepted.every(draft => draft.kind === 'acceptChange' && draft.path === 'main.tex'));
    await vscode.commands.executeCommand('turnleaf.acceptAllChanges', { path: 'main.tex' });
    assert.equal((await state.read()).pending.length, 0, 'Accept all again undoes all');
    // Reject in selection decides only the suggestions the selection touches; again undoes them.
    const end = source.document.getText().length;
    source.selection = new vscode.Selection(source.document.positionAt(end - 4), source.document.positionAt(end));
    await vscode.commands.executeCommand('turnleaf.rejectSelectionChanges');
    const rejected = (await state.read()).pending;
    assert.deepEqual(rejected.map(draft => [draft.kind, draft.change?.text]), [['rejectChange', ' BBB']], 'Only the selected suggestion is rejected');
    await vscode.commands.executeCommand('turnleaf.rejectSelectionChanges');
    assert.equal((await state.read()).pending.length, 0, 'Reject in selection again undoes it');
    // Accept by author decides that author's suggestions in the file.
    const reviewerRow = api.reviewView().suggestionRows!.find(row => row.path === 'main.tex' && row.text === ' AAA')!, reviewerKey = reviewerRow.authorId ?? reviewerRow.author;
    const fromReviewer = api.reviewView().suggestionRows!.filter(row => row.path === 'main.tex' && (row.authorId ?? row.author) === reviewerKey).length;
    await vscode.commands.executeCommand('turnleaf.acceptAuthorChanges', { path: 'main.tex', value: reviewerKey });
    assert.equal((await state.read()).pending.filter(draft => draft.kind === 'acceptChange').length, fromReviewer);
    await vscode.commands.executeCommand('turnleaf.acceptAuthorChanges', { path: 'main.tex', value: reviewerKey });
    assert.equal((await state.read()).pending.length, 0, 'Accept by author again undoes it');
    // A card deletes your own message as a draft.
    const ownMessage = fixture.threads.c1.messages[0].id;
    await vscode.commands.executeCommand('turnleaf.deleteMessage', { value: 'c1', message: ownMessage });
    const deletion = (await state.read()).pending.find(draft => draft.kind === 'deleteMessage');
    assert.equal(deletion?.messageId, ownMessage); await state.discard(deletion!.id); await api.refreshLocal();
    await vscode.commands.executeCommand('turnleaf.showSyncHistory');
    const history = await state.history(); assert(history.length >= 4); assert(history.every(record => record.outcome === 'success'));
    await vscode.commands.executeCommand('turnleaf.historyDiff', { entry: history.find(record => record.files.length)?.id, path: 'main.tex' });
    assert(!existsSync(folder.uri.fsPath + '/.git'));
    // Choose source files adds a local-only file: while the new selection is first read,
    // the status neither reports stale cached comments nor a lost connection.
    await writeFile(vscode.Uri.joinPath(folder.uri, 'extra.tex').fsPath, 'A file only in the local folder.\n');
    assert.equal(api.reviewView().connected, true);
    const baseline = await state.read(), historyLength = (await state.history()).length, rendered = api.reviewRenders().length;
    await vscode.commands.executeCommand('turnleaf.configureFiles', { testPaths: ['main.tex', 'references.bib', 'extra.tex'] });
    const renders = api.reviewRenders().slice(rendered);
    assert(renders.some(render => render.state === 'Checking Overleaf…'), `The read of the new selection is shown as a check: ${JSON.stringify(renders)}`);
    for (const render of renders) assert(render.connected && !/may be stale|Connect to an Overleaf project/.test(render.state), `No stale or disconnected status while the new selection is read: ${JSON.stringify(renders)}`);
    assert.deepEqual(api.reviewView().files, ['main.tex', 'references.bib', 'extra.tex']);
    assert.notEqual(api.reviewView().state, 'Checking Overleaf…', 'The check ends with the read');
    assert((await summary(o => o.files.some(f => f.path === 'extra.tex'), 'The local-only file is listed as going out')).files.find(f => f.path === 'extra.tex')?.note?.startsWith('New on Overleaf'));
    // The sidebar's Full/Fast switch writes the folder's sendCheck setting.
    const folderCheck = () => vscode.workspace.getConfiguration('turnleaf', folder.uri).inspect<string>('sendCheck')?.workspaceFolderValue;
    await summary(o => o.check?.mode === 'full', 'The switch starts on Full');
    await vscode.commands.executeCommand('turnleaf.setSendCheck', { value: 'fast' });
    await summary(o => o.check?.mode === 'fast', 'The switch shows Fast once chosen');
    assert.equal(folderCheck(), 'fast');
    await vscode.commands.executeCommand('turnleaf.setSendCheck', { value: 'full' });
    await summary(o => o.check?.mode === 'full' && folderCheck() === 'full', 'The switch goes back to Full');
    const grown = new ProjectStore(folder.uri.fsPath, fixture.baseUrl, 'test-project', ['main.tex', 'references.bib', 'extra.tex']);
    assert.equal((await grown.read()).revision, baseline.revision, 'Adding a file keeps the sync baseline');
    assert.equal((await grown.history()).length, historyLength, 'Adding a file keeps the sync history');
    // Opening the window: the cached review reads "Checking Overleaf…" until the first read, which starts at once.
    const reopened = api.reviewRenders().length;
    await api.restoreLocal(true);
    const startup = api.reviewRenders().slice(reopened);
    assert(startup.some(render => render.state === 'Checking Overleaf…'), `The first read after opening is shown as a check: ${JSON.stringify(startup)}`);
    for (const render of startup) assert(!/may be stale|Connect to an Overleaf project/.test(render.state) && (render.connected || render.state === 'Checking Overleaf…'), `No stale or signed-out status while the first read runs: ${JSON.stringify(startup)}`);
    assert.equal(api.reviewView().connected, true); assert.notEqual(api.reviewView().state, 'Checking Overleaf…', 'The check ends with the first read');
    const result = { status: 'ready', runtime: api.runtime(), files: inspection.docs.length, contentWrites, inspectionRejectsTyping: true, localFilesUnchangedDuringInspection: true, localThreads: 4, reviewLog: true, localStatus: true, sidePanel: true, sidebar: true, nativeDiffs: true, diffRetainsCommentContext: true, reversibleOutlineMarkers: true, savedFileSend: true, previewBeforeApply: true, dirtyBufferInvalidatesReview: true, remoteCheckInvalidatesReview: true, queuedReplyAndEdit: true, newSelectionComment: true, reattachPreservesDependencies: true, nativeGlyphRanges: true, wholeBufferPreservesAnchorsAndDrafts: true, plaintextConflictResolution: true, persistedSyncHistory: true, noGitRequired: true, refreshPreservesEditDraft: true, incrementalMapping: true, undoRestoresAnchors: true, activeSplitFollowsSource: true, cachedReviewWithoutNetwork: true, largeComparisonWorker: true, suggestionDecisions: true, overlappingRedrawsKeepThreads: true, highlightSwitch: true, filterDrivenHighlights: true, quietNavigation: true, acceptAll: true, selectionAndAuthorDecisions: true, cardDelete: true, firstSyncKeptSend: true, selectionChangeShowsCheck: true, startupShowsCheck: true, sendCheckSwitch: true };
    await writeFile(resultPath, JSON.stringify(result, null, 2));
    if (process.env.TURNLEAF_SMOKE_HOLD === '1') {
      const deadline = Date.now() + 5 * 60_000;
      while (!existsSync(resultPath + '.continue') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 200));
    }
    await vscode.commands.executeCommand('turnleaf.signOut');
    assert.equal(await api.sessionStored(), false);
    assert.equal(fixture.sockets.size, 0);
    await writeFile(resultPath, JSON.stringify({ ...result, status: 'passed', signOutClearedSecret: true }, null, 2));
  } catch (error) {
    await writeFile(resultPath, JSON.stringify({ status: 'failed', message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack?.split('\n').filter(line => /^\s+at /.test(line)).slice(0, 4).join('\n') : undefined }));
    throw error;
  } finally { await fixture.close(); }
}
