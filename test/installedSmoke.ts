import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { GitStore } from '../src/core/git';

// Runs in a separate test-driver extension. The toolbox is installed from its VSIX
// and runs in Production mode, with no private test API or development hooks.
export async function run() {
  const resultPath = process.env.TURNLEAF_SMOKE_RESULT!;
  try {
    const folder = vscode.workspace.workspaceFolders![0], root = folder.uri.fsPath, git = new GitStore(root);
    await git.run(['init', '-b', 'main']); await git.run(['config', 'user.name', 'Installed smoke']); await git.run(['config', 'user.email', 'test@example.invalid']);
    await writeFile(join(root, 'main.tex'), 'Alpha βeta.\nSecond line.\n'); await writeFile(join(root, 'references.bib'), 'Jörg cite.\n');
    await git.run(['add', '.']); await git.run(['commit', '-m', 'Installed test baseline']);
    const extension = vscode.extensions.getExtension('zeyuxu.turnleaf'); assert(extension);
    assert.equal(await extension.activate(), undefined, 'Installed extension must not expose the test API');
    if (process.env.TURNLEAF_INSTALLED_INTERACTIVE === '1') {
      await writeFile(resultPath, JSON.stringify({ status: 'awaiting-sign-in' }));
      await vscode.commands.executeCommand('turnleaf.signIn');
    }
    await vscode.commands.executeCommand('turnleaf.inspectProject');
    assert.match(vscode.window.activeTextEditor?.document.getText() ?? '', /Fixture Review/);
    await vscode.commands.executeCommand('turnleaf.refreshComments');
    const files = await readdir(join(root, '.turnleaf/cache')); assert(files.some(f => f.endsWith('.json')));
    await vscode.commands.executeCommand('turnleaf.exportReviewLog');
    assert.match(await readFile(join(root, 'docs/overleaf_review_log.md'), 'utf8'), /Review c1/);
    await vscode.commands.executeCommand('turnleaf.openThread', 'c1');
    assert.equal(vscode.window.activeTextEditor?.document.uri.scheme, 'file');
    await vscode.commands.executeCommand('turnleaf.signOut');
    await writeFile(resultPath, JSON.stringify({ status: 'passed', app: vscode.env.appName, vscode: vscode.version, installed: extension.extensionPath, productionMode: true, localComments: true, exportedLog: true, sessionAccepted: true, signOut: true }, null, 2));
  } catch (error) {
    await writeFile(resultPath, JSON.stringify({ status: 'failed', message: error instanceof Error ? error.message : String(error) })); throw error;
  }
}
