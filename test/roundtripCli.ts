import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OverleafReader } from '../src/core/overleaf';
import { SessionExpiredError } from '../src/core/errors';
import { threadFileName, type ThreadFile } from '../src/core/reviewFiles';
import type { Inspection } from '../src/core/models';
import {
  commentQuote, Detail, errorText, GuardResult, leftoverCounts, leftovers, markers, nameGuard, projectState, ProjectState,
  stateDifferences, StepFailure, Steps, threadWithFirstMessage, MARKER_PREFIX,
} from './roundtripCore';

// The command-line leg of the live roundtrip test: the same new comment, reply, resolution
// and cleanup as the extension leg, through dist/cli.js in its own folder. It also records
// whether Overleaf renewed the session cookie while the commands ran. The cookie is read
// from the session file into memory only; it is never printed, logged or written to the result.

export interface CliLegInput { cli: string; folder: string; sessionFile: string; baseUrl: string; projectId: string; runId: string }
export interface CliCommand { command: string; exitCode: number | null; durationMs: number; renewedCookie: boolean }
export interface CliLegResult {
  status: 'done' | 'refused' | 'session-expired' | 'failed';
  guard?: GuardResult; steps: Steps['list']; commands: CliCommand[];
  /** Whether Overleaf renewed the session during the leg: the CLI saved a new cookie (`savedByCli`), or the test's own reader received one (`seenByReader`). */
  cookie: { savedByCli: boolean | null; seenByReader: boolean | null; commandsThatRenewed: string[] };
  cleanup: { completed: boolean; remaining: Detail | null; differences: string[] };
  message?: string;
  /** For the caller's redaction only; never written. */
  secrets: string[];
}

export async function runCliLeg(input: CliLegInput): Promise<CliLegResult> {
  const steps = new Steps('cli'), commands: CliCommand[] = [], secrets: string[] = [];
  const m = markers(input.runId, 'cli'), own = (text: string | undefined) => !!text?.startsWith(`${MARKER_PREFIX} ${input.runId} cli`);
  const readCookie = async () => { const value = (await readFile(input.sessionFile, 'utf8')).trim(); if (value) secrets.push(value); return value; };
  const result: CliLegResult = { status: 'done', steps: steps.list, commands, cookie: { savedByCli: null, seenByReader: null, commandsThatRenewed: [] }, cleanup: { completed: false, remaining: null, differences: [] }, secrets };
  let initial: string;
  try { initial = await readCookie(); } catch { return { ...result, status: 'session-expired', message: 'No command-line session file.' }; }
  if (!initial) return { ...result, status: 'session-expired', message: 'The command-line session file is empty.' };
  const reader = new OverleafReader(input.baseUrl, initial);

  // One CLI command, with --json; the session file is the only cookie source (TURNLEAF_COOKIE would stop renewal from being saved).
  async function cli(args: string[]): Promise<{ code: number | null; json: any; stderr: string }> {
    const before = (await readFile(input.sessionFile, 'utf8')).trim(), started = Date.now();
    const childEnv = { ...process.env }; delete childEnv.TURNLEAF_COOKIE; delete childEnv.TURNLEAF_SESSION_FILE; delete childEnv.TURNLEAF_BASE_URL;
    const child = spawn(process.execPath, [input.cli, ...args, '--folder', input.folder, '--base-url', input.baseUrl, '--session-file', input.sessionFile, '--json'], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4_000); });
    const code = await new Promise<number | null>(resolve => { child.on('exit', resolve); child.on('error', () => resolve(null)); });
    const renewedCookie = (await readCookie()) !== before;
    const name = args.filter(arg => !/^[0-9a-f]{24}$/i.test(arg) && arg !== input.projectId).join(' ');
    commands.push({ command: name, exitCode: code, durationMs: Date.now() - started, renewedCookie });
    if (renewedCookie) result.cookie.commandsThatRenewed.push(name);
    let json: any;
    try { json = JSON.parse(stdout); } catch { /* not JSON */ }
    return { code, json, stderr };
  }
  // A failed command: its exit code and the last line it wrote to stderr, or the reason it was blocked.
  const failure = (label: string, run: { code: number | null; json: any; stderr: string }) => {
    const said = typeof run.json?.blocked === 'string' ? run.json.blocked : run.stderr.trim().split('\n').at(-1) ?? '';
    return new StepFailure(`${label} exited with ${run.code}${said ? `: ${said.slice(0, 300)}` : ''}`, { exitCode: run.code });
  };
  const expectOk = async (label: string, args: string[]) => { const run = await cli(args); if (run.code !== 0) throw failure(label, run); return run; };

  let paths: string[] = [], reviewDir: string | undefined, baseline: ProjectState | undefined;
  const read = async (): Promise<Inspection> => reader.inspect(input.projectId, paths);
  const ownThread = (inspection: Inspection, text: string) => {
    const id = threadWithFirstMessage(inspection, text);
    if (!id) throw new StepFailure('The thread is not on Overleaf.');
    return { id, thread: inspection.threads[id] };
  };
  async function editThread(threadId: string, edit: (file: ThreadFile) => void, label: string) {
    const path = join(reviewDir!, 'threads', threadFileName(threadId));
    if (!existsSync(path)) throw new StepFailure(`The thread file for ${label} is missing.`);
    const file: ThreadFile = JSON.parse(await readFile(path, 'utf8'));
    edit(file);
    await writeFile(path, JSON.stringify(file, null, 2) + '\n');
  }
  // `send --dry-run` must list exactly the queued comment change, then `send --yes` writes it.
  async function sendComments(label: string, extra: string[] = []): Promise<Detail> {
    const dry = await expectOk(`send --dry-run (${label})`, ['send', '--dry-run', ...extra]);
    const planned = dry.json?.comments?.length ?? 0, files = dry.json?.files?.length ?? 0;
    if (planned !== 1 || files) throw new StepFailure(`send --dry-run listed ${planned} comment change(s) and ${files} file(s); expected 1 and 0.`);
    const sent = await expectOk(`send --yes (${label})`, ['send', '--yes', '--comments-only', ...extra]);
    if (sent.json?.sent !== true) throw new StepFailure('send --yes did not report sent.');
    if (sent.json.mismatches?.length) throw new StepFailure(`send reported ${sent.json.mismatches.length} mismatch(es).`);
    return { planned };
  }

  try {
    // The name guard, before anything is written.
    let projects;
    try { projects = await reader.listProjects(); }
    catch (error) { if (error instanceof SessionExpiredError) return { ...result, status: 'session-expired' }; throw error; }
    result.guard = nameGuard(input.projectId, projects);
    if (result.guard.passed) {
      paths = (await reader.listSourceFiles(input.projectId)).paths.filter(path => /\.(tex|bib|sty|cls)$/i.test(path));
      const start = await read();
      result.guard = nameGuard(input.projectId, projects, start.projectName);
    }
    if (!result.guard.passed) return { ...result, status: 'refused' };

    const linked = await steps.run('cli-link', async () => {
      const run = await expectOk('link', ['link', input.projectId, '--all-sources']);
      const linkedPaths: string[] = run.json?.paths ?? [];
      if (JSON.stringify([...linkedPaths].sort()) !== JSON.stringify([...paths].sort())) throw new StepFailure('link chose other files than the project has.');
      return { value: true, detail: { files: linkedPaths.length } };
    });
    const pulled = linked && await steps.run('cli-pull', async () => {
      const run = await expectOk('pull', ['pull']);
      reviewDir = run.json?.reviewFiles;
      if (typeof reviewDir !== 'string' || !existsSync(join(reviewDir, 'REVIEW.md'))) throw new StepFailure('pull did not create the review files.');
      const start = await read();
      for (const doc of start.docs) if (!existsSync(join(input.folder, doc.path)) || await readFile(join(input.folder, doc.path), 'utf8') !== doc.text) throw new StepFailure(`${doc.path} differs from Overleaf after pull.`);
      return { value: true, detail: { files: run.json?.files?.length ?? 0, changed: run.json?.changed ?? null } };
    });
    const ready = pulled && await steps.run('cli-status', async () => {
      const run = await expectOk('status', ['status']);
      const planned = (run.json?.comments?.length ?? 0) + (run.json?.files?.length ?? 0);
      if (planned) throw new StepFailure(`status lists ${planned} change(s) right after pull; expected none.`);
      return { value: true, detail: { problems: run.json?.problems?.length ?? 0 } };
    });
    if (ready) {
      const start = await read();
      baseline = projectState(start);
      try {
        const created = await steps.run('cli-comment-new', async () => {
          const doc = start.docs.find(doc => doc.path.endsWith('.tex') && commentQuote(doc.text)) ?? start.docs.find(doc => commentQuote(doc.text));
          if (!doc) throw new StepFailure('No line of at least 8 characters occurs exactly once in the selected files.');
          const id = `${m.id}-comment`;
          await writeFile(join(reviewDir!, 'new', `${id}.json`), JSON.stringify({ id, path: doc.path, quote: commentQuote(doc.text), text: m.comment }, null, 2) + '\n');
          const detail = await sendComments('new comment');
          const after = await read(), { id: threadId } = ownThread(after, m.comment);
          const anchor = after.docs.flatMap(d => d.comments).find(anchor => anchor.threadId === threadId);
          if (anchor?.state !== 'placed') throw new StepFailure(`The comment is on Overleaf but its anchor is ${anchor?.state ?? 'missing'}.`);
          return { value: threadId, detail: { ...detail, anchor: anchor.state } };
        });
        const replied = created && await steps.run('cli-comment-reply', async () => {
          await editThread(created, file => { file.localEdits.push({ id: `${m.id}-reply`, action: 'reply', text: m.reply }); }, 'the reply');
          const detail = await sendComments('reply');
          const { thread } = ownThread(await read(), m.comment);
          if (!thread.messages.some(message => message.text === m.reply)) throw new StepFailure('The reply is not on Overleaf.');
          return { value: true, detail: { ...detail, messages: thread.messages.length } };
        });
        if (replied) await steps.run('cli-comment-resolve', async () => {
          await editThread(created, file => { file.localEdits.push({ id: `${m.id}-resolve`, action: 'resolve' }); }, 'the resolution');
          const detail = await sendComments('resolution');
          if (!ownThread(await read(), m.comment).thread.resolved) throw new StepFailure('The thread is not resolved on Overleaf.');
          return { detail: { ...detail, resolved: true } };
        });
      } finally {
        // Cleanup, also after a failed step: delete this leg's threads through the CLI. Earlier
        // leftovers and the extension leg's are the editor's final cleanup.
        const found = (inspection: Inspection) => Object.entries(inspection.threads).filter(([, thread]) => own(thread.messages[0]?.text)).map(([id]) => id);
        const mine = found(await read().catch(() => ({ threads: {} } as Inspection)));
        if (mine.length) await steps.run('cli-cleanup-delete-thread', async () => {
          const run = await cli(['pull']);
          if (run.code !== 0) throw failure('pull (before the deletion)', run);
          for (const [n, threadId] of mine.entries()) await editThread(threadId, file => { file.localEdits = [{ id: `${m.id}-delete-${n + 1}`, action: 'deleteThread' }]; }, 'the deletion');
          const dry = await expectOk('send --dry-run (deletion)', ['send', '--dry-run', '--allow-deletes']);
          if ((dry.json?.comments?.length ?? 0) !== mine.length || dry.json?.files?.length) throw new StepFailure('send --dry-run did not list exactly the deletion(s).');
          await expectOk('send --yes (deletion)', ['send', '--yes', '--comments-only', '--allow-deletes']);
          const left = found(await read());
          if (left.length) throw new StepFailure('A test thread is still on Overleaf after send.', { threads: left.length });
          return { detail: { deleted: mine.length } };
        });
        await steps.run('cli-cleanup-verify', async () => {
          const now = await read(), left = found(now), differences = baseline ? stateDifferences(baseline, projectState(now)) : [];
          result.cleanup = { completed: !left.length && !differences.length, remaining: { ...leftoverCounts(leftovers(now)), ownThreads: left.length }, differences };
          if (left.length) throw new StepFailure(`${left.length} thread(s) of this leg left on Overleaf.`);
          if (differences.length) throw new StepFailure(`The project differs from its state before this leg: ${differences.join('; ')}.`);
          return { detail: { sameAsStart: true } };
        });
      }
    }
  } catch (error) {
    result.status = 'failed'; result.message = errorText(error);
  }
  try {
    const now = await readFile(input.sessionFile, 'utf8');
    result.cookie.savedByCli = now.trim() !== initial;
    result.cookie.seenByReader = reader.sessionCookie !== initial;
    if (reader.sessionCookie) secrets.push(reader.sessionCookie);
  } catch { /* the file went away */ }
  return result;
}
