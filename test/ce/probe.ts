import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { summarizeError, summarizeInspection } from '../../src/core/probe';
import type { TestApi } from '../../src/extension/extension';
import { checkInspection } from './check';
import type { SeededProject } from './harness';

// Extension-test entry for scripts/ce.mjs. It signs in through the extension's own sign-in
// function with the cookie from the scripted Community Edition login, inspects each seeded
// throwaway project and compares the result with what the harness seeded.
export async function run(): Promise<void> {
  const env = process.env, resultPath = env.TURNLEAF_CE_RESULT!;
  const result: Record<string, unknown> = {};
  const errors: { step: string; code: string; status?: number; message: string }[] = [];
  const step = async <T>(name: string, action: () => Promise<T>): Promise<T | undefined> => {
    try { return await action(); } catch (error) { errors.push({ step: name, ...summarizeError(error) }); return undefined; }
  };
  try {
    // The cookie file is removed as soon as it is read; the runner also removes its directory.
    const cookie = (await readFile(env.TURNLEAF_CE_COOKIE_FILE!, 'utf8')).trim();
    await rm(env.TURNLEAF_CE_COOKIE_FILE!, { force: true });
    const projects = JSON.parse(await readFile(env.TURNLEAF_CE_EXPECT!, 'utf8')) as SeededProject[];
    const extension = vscode.extensions.getExtension<TestApi>('zeyuxu.turnleaf');
    const api = await extension?.activate();
    if (!api) throw new Error('The extension did not expose its test API.');
    let appVersion: string | undefined;
    try { appVersion = JSON.parse(readFileSync(join(vscode.env.appRoot, 'product.json'), 'utf8')).version; } catch { /* optional */ }
    result.runtime = { app: vscode.env.appName, appVersion, vscodeApi: vscode.version, extensionHostNode: process.versions.node,
      platform: `${process.platform}-${process.arch}`, extension: extension!.packageJSON.version };

    const folder = vscode.workspace.workspaceFolders![0];
    const signedIn = await step('signIn', () => api.signIn(cookie).then(() => true));
    result.session = { accepted: Boolean(signedIn), stored: await api.sessionStored() };
    const inspected = [];
    for (const project of signedIn ? projects : []) {
      await vscode.workspace.getConfiguration('turnleaf', folder.uri).update('projectId', project.projectId, vscode.ConfigurationTarget.WorkspaceFolder);
      await vscode.workspace.getConfiguration('turnleaf', folder.uri).update('trackedFiles', project.expectations.docs.map(doc => doc.path), vscode.ConfigurationTarget.WorkspaceFolder);
      const started = Date.now();
      const inspection = await step(`inspect ${project.label}`, () => api.inspect());
      const entry: Record<string, unknown> = { label: project.label, inspect: { durationMs: Date.now() - started, error: errors.find(error => error.step === `inspect ${project.label}`) ?? null } };
      if (inspection) {
        entry.inspection = summarizeInspection(inspection);
        entry.positionProblems = checkInspection(inspection, project.expectations);
        // Opening each file creates the editor comment threads from the anchors.
        let opened = 0;
        for (const doc of inspection.docs) if (await step(`open ${project.label} ${doc.path}`, () => api.openFile(doc.path))) opened++;
        entry.openedFiles = opened;
      } else entry.positionProblems = [];
      inspected.push(entry);
    }
    result.projects = inspected;
    const settings = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, '.vscode/settings.json'));
    result.cookieInSettings = Buffer.from(settings).toString().includes(cookie);
    await step('signOut', async () => { await vscode.commands.executeCommand('turnleaf.signOut'); });
    result.signOutClearedSecret = !(await api.sessionStored());
  } catch (error) {
    errors.push({ step: 'probe', code: 'unexpected', message: error instanceof Error ? error.message : String(error) });
  }
  result.errors = errors;
  await writeFile(resultPath, JSON.stringify(result, null, 2) + '\n');
}
