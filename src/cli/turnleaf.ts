// Headless command line for scripts and AI agents. It drives the same core
// workflow as the extension: Get latest, the local review files, and Send.
// Nothing reaches Overleaf without `send --yes`; see docs/guide/command-line.md.
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { OverleafReader } from '../core/overleaf';
import { ProjectStore, isDecision } from '../core/projectStore';
import { ReviewWorkflow, SyncService, pushReport, pullChanges, sameContent, type PushPlan } from '../core/folderWorkflow';
import { LocalReviewFiles } from '../core/reviewFiles';
import { validateTrackedFiles } from '../core/docState';
import { normalizeBaseUrl } from '../core/http';
import { SessionExpiredError, SyncError, safeError } from '../core/errors';
import { browserSignIn, findBrowser } from '../core/browserSignIn';
import { withOperation } from '../core/operation';
import { atomicJson, workspacePath } from '../core/storage';
import { sendsPicture } from '../core/pictures';

export interface Io { out(line: string): void; err(line: string): void; env: NodeJS.ProcessEnv; cwd: string; }
/** Exit codes: 0 done, 1 failed, 2 usage, 3 needs a decision (conflict, policy refusal, blocked send), 4 signed out. */
export const exitCodes = { ok: 0, failed: 1, usage: 2, blocked: 3, signedOut: 4 } as const;
const defaultBaseUrl = 'https://www.overleaf.com';

const usage = `Usage: turnleaf <command> [options]

  sign-in   [--browser PATH] [--headless]     Sign in with a browser window and save the session.
  projects                                    List the projects of the signed-in account.
  link      <project-id> [--files a.tex,b.bib | --all-sources]
                                              Link the folder to a project and choose its files.
  pull      [--take-overleaf] [--dry-run]     Get latest: merge Overleaf's files and comments into the folder.
  status                                      Import review files and show what Send would do.
  send      --yes | --dry-run [--comments-only] [--allow-untracked-edits] [--allow-deletes]
                                              Send queued comments and saved edits to Overleaf. Edits are
                                              refused unless Track Changes is on for this account.

Common options:
  --folder DIR        Working folder (default: current folder).
  --base-url URL      Overleaf server (default: TURNLEAF_BASE_URL or https://www.overleaf.com). Must match
                      the server a folder is linked to.
  --session-file F    Where the session cookie is kept (default: TURNLEAF_SESSION_FILE or
                      ~/.config/turnleaf/session-<server>). TURNLEAF_COOKIE overrides it.
  --pictures          Also synchronize pictures (PNG, JPG, PDF) in pull, status and send. Off by default.
  --json              Print results, and every failure, as JSON.`;

interface Options { [name: string]: string | boolean | undefined }
const flags = new Set(['headless', 'all-sources', 'take-overleaf', 'dry-run', 'yes', 'comments-only', 'allow-untracked-edits', 'allow-deletes', 'pictures', 'json', 'help']);
const valued = new Set(['folder', 'base-url', 'session-file', 'browser', 'files']);
const common = ['folder', 'base-url', 'session-file', 'json', 'help'];
/** The options and the number of positional arguments each command takes. */
const commands: Record<string, { options: string[]; positional: number }> = {
  'sign-in': { options: ['browser', 'headless'], positional: 0 },
  projects: { options: [], positional: 0 },
  link: { options: ['files', 'all-sources'], positional: 1 },
  pull: { options: ['take-overleaf', 'dry-run', 'pictures'], positional: 0 },
  status: { options: ['pictures'], positional: 0 },
  send: { options: ['yes', 'dry-run', 'comments-only', 'allow-untracked-edits', 'allow-deletes', 'pictures'], positional: 0 },
};
function parse(argv: string[]): { command?: string; positional: string[]; options: Options } {
  const positional: string[] = [], options: Options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
    if (flags.has(name)) { if (inline !== undefined) throw new UsageError(`--${name} takes no value.`); options[name] = true; continue; }
    if (!valued.has(name)) throw new UsageError(`Unknown option --${name}.`);
    const value = inline ?? argv[++i];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`--${name} needs a value.`);
    options[name] = value;
  }
  return { command: positional.shift(), positional, options };
}
/** Refuses what the command does not take, before any file or credential is read. */
function check(command: string, positional: string[], options: Options, io: Io): void {
  const spec = commands[command];
  if (!spec) throw new UsageError(`Unknown command: ${command}`);
  const wrong = Object.keys(options).filter(name => !common.includes(name) && !spec.options.includes(name));
  if (wrong.length) throw new UsageError(`${command} does not take ${wrong.map(name => `--${name}`).join(', ')}.`);
  if (positional.length !== spec.positional) throw new UsageError(spec.positional ? `${command} takes ${spec.positional} argument${spec.positional > 1 ? 's' : ''}.` : `${command} takes no arguments: ${positional.join(' ')}`);
  for (const value of [options['base-url'], io.env.TURNLEAF_BASE_URL]) if (typeof value === 'string') asUsage(() => normalizeBaseUrl(value));
  if (command === 'send' && !options.yes && !options['dry-run']) throw new UsageError('send writes to Overleaf: add --yes, or use --dry-run to see what it would write.');
  if (command === 'send' && options.yes && options['dry-run']) throw new UsageError('Choose --yes or --dry-run, not both.');
}
/** Invalid caller input reported by the core becomes a usage error. */
function asUsage<T>(action: () => T): T {
  try { return action(); } catch (error) { if (error instanceof SyncError) throw new UsageError(error.message); throw error; }
}
class UsageError extends Error {}
/** A refusal the caller must resolve: a conflict, a policy check or a blocked Send. */
class Blocked extends Error { constructor(message: string, readonly code: string, readonly details: unknown = undefined) { super(message); } }

/** Error codes of the core that ask the caller for a decision (exit code 3). */
const decisionCodes = new Set(['incoming', 'recovery', 'stale', 'review-files', 'conflict', 'missing', 'read-only']);
/** The exit code and stable code of a failure, from the error's `code`, whichever layer raised it. */
export function failureOf(error: unknown): { exitCode: number; code: string; message: string; details?: unknown } {
  if (error instanceof UsageError) return { exitCode: exitCodes.usage, code: 'usage', message: error.message };
  if (error instanceof Blocked) return { exitCode: exitCodes.blocked, code: error.code, message: error.message, ...error.details !== undefined && { details: error.details } };
  if (error instanceof SyncError && error.code === 'session-expired') return { exitCode: exitCodes.signedOut, code: error.code, message: 'Not signed in, or the Overleaf session expired. Run turnleaf sign-in, or set TURNLEAF_COOKIE.' };
  if (error instanceof SyncError) return { exitCode: decisionCodes.has(error.code) ? exitCodes.blocked : exitCodes.failed, code: error.code, message: safeError(error) };
  return { exitCode: exitCodes.failed, code: 'failed', message: safeError(error) };
}

interface Link { schema: 1; baseUrl: string; projectId: string; paths: string[] }
// Through the core's path check, which refuses a symbolic link on the way to the file.
const linkFile = (folder: string) => workspacePath(folder, '.turnleaf/cli.json');
async function readLink(folder: string): Promise<{ link: Link; raw: string; file: string }> {
  const file = await linkFile(folder);
  let raw: string, value: Link;
  try { raw = await readFile(file, 'utf8'); value = JSON.parse(raw); }
  catch (error: any) { if (error.code === 'ENOENT') throw new UsageError('This folder is not linked. Run turnleaf link <project-id> first.'); throw new SyncError(`Cannot read ${file}.`, 'configuration'); }
  if (value?.schema !== 1 || typeof value.projectId !== 'string' || !value.projectId || typeof value.baseUrl !== 'string') throw new SyncError(`Unsupported ${file}.`, 'configuration');
  return { link: { ...value, baseUrl: normalizeBaseUrl(value.baseUrl), paths: validateTrackedFiles(value.paths) }, raw, file };
}

function baseUrlOf(options: Options, io: Io): string {
  return normalizeBaseUrl(String(options['base-url'] ?? io.env.TURNLEAF_BASE_URL ?? defaultBaseUrl));
}
const explicitSessionFile = (options: Options, io: Io) => options['session-file'] ?? io.env.TURNLEAF_SESSION_FILE;
const originHash = (baseUrl: string) => createHash('sha256').update(new URL(baseUrl).origin).digest('hex').slice(0, 16);
function sessionFile(options: Options, io: Io, baseUrl: string): string {
  const explicit = explicitSessionFile(options, io);
  if (typeof explicit === 'string') return resolve(io.cwd, explicit);
  return join(io.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'turnleaf', `session-${originHash(baseUrl)}`);
}
/** The private browser profile of one session file on one server, next to the file. */
export function signInProfile(file: string, baseUrl: string): string {
  return join(dirname(file), `sign-in-${createHash('sha256').update(JSON.stringify([new URL(baseUrl).origin, resolve(file)])).digest('hex').slice(0, 16)}`);
}
/**
 * The server for a linked folder. The link file lives in the folder and may come
 * from anyone, so a cookie that is not tied to a server (TURNLEAF_COOKIE or a
 * chosen session file) only goes to the server the caller named, or to the
 * default one. The default session file is per server and needs no such check.
 */
function linkedServer(link: Link, options: Options, io: Io): string {
  const explicit = options['base-url'] ?? io.env.TURNLEAF_BASE_URL, expected = baseUrlOf(options, io);
  const unscoped = !!io.env.TURNLEAF_COOKIE || explicitSessionFile(options, io) !== undefined;
  if (link.baseUrl !== expected && (explicit !== undefined || unscoped))
    throw new UsageError(`This folder is linked to ${link.baseUrl}, but the session is for ${expected}. Pass --base-url ${link.baseUrl} if you trust that server, or link the folder again.`);
  return link.baseUrl;
}
const inside = (folder: string, file: string) => { const rel = relative(folder, file); return !rel || !rel.startsWith('..') && !isAbsolute(rel); };
/** Refuses a session file that is a symbolic link, not a plain file, or readable by others. */
async function checkSessionFile(path: string, existing: 'read' | 'write'): Promise<boolean> {
  let stat;
  try { stat = await lstat(path); } catch (error: any) { if (error.code === 'ENOENT') return false; throw error; }
  if (stat.isSymbolicLink()) throw new SyncError(`Refusing the session file ${path}: it is a symbolic link.`, 'configuration');
  if (!stat.isFile()) throw new SyncError(`Refusing the session file ${path}: it is not a file.`, 'configuration');
  if (existing === 'read' && process.platform !== 'win32' && stat.mode & 0o077) throw new SyncError(`Refusing the session file ${path}: others can read it. Run chmod 600 on it.`, 'configuration');
  return true;
}
async function readSession(path: string): Promise<string | undefined> {
  if (!await checkSessionFile(path, 'read')) return undefined;
  return (await readFile(path, 'utf8')).trim() || undefined;
}
/** Replaces the session file in one step with a file that is private from its creation. */
async function saveSession(path: string, cookie: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await checkSessionFile(path, 'write');
  const temp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temp, cookie + '\n', { mode: 0o600, flag: 'wx' }); await rename(temp, path); }
  catch (error) { await rm(temp, { force: true }); throw error; }
}

export async function run(argv: string[], io: Io): Promise<number> {
  const json = argv.includes('--json');
  const fail = (error: unknown) => {
    const failure = failureOf(error);
    if (json) io.out(JSON.stringify({ error: failure.message, code: failure.code, exitCode: failure.exitCode, ...failure.details !== undefined && { details: failure.details } }, null, 2));
    else io.err(failure.message);
    if (failure.exitCode === exitCodes.usage && !json) io.err('Run turnleaf --help for the commands and options.');
    return failure.exitCode;
  };
  let parsed: ReturnType<typeof parse>;
  try { parsed = parse(argv); } catch (error) { return fail(error); }
  const { command, positional, options } = parsed;
  // Help asked for (--help or help) goes to stdout and succeeds; no command at all is a usage error.
  if (options.help || command === 'help') { io.out(usage); return exitCodes.ok; }
  if (!command) { io.err(usage); return exitCodes.usage; }
  try { check(command, positional, options, io); } catch (error) { return fail(error); }
  const folder = resolve(io.cwd, String(options.folder ?? '.'));
  const print = (text: string, data: unknown) => io.out(options.json ? JSON.stringify(data, null, 2) : text);
  const warn = (line: string) => io.err(`Warning: ${line}`);
  const controller = new AbortController();
  // Cookies Overleaf renewed, saved once the command has finished, also after a refusal or an error.
  const renewals: (() => Promise<void>)[] = [];
  /** The reader for a server. A cookie Overleaf renews is saved when the command ends. */
  async function connect(baseUrl: string, inFolder: boolean): Promise<OverleafReader> {
    const file = sessionFile(options, io, baseUrl);
    if (inFolder && explicitSessionFile(options, io) !== undefined && inside(folder, file)) throw new UsageError('Keep the session file outside the working folder: it is a password.');
    const cookie = io.env.TURNLEAF_COOKIE || await readSession(file);
    if (!cookie) throw new SessionExpiredError();
    const reader = new OverleafReader(baseUrl, cookie);
    if (!io.env.TURNLEAF_COOKIE) renewals.push(async () => { const now = reader.sessionCookie; if (now && now !== cookie) await saveSession(file, now); });
    return reader;
  }
  async function workflowFor(link: Link, reader: OverleafReader) {
    const state = new ProjectStore(folder, link.baseUrl, link.projectId, link.paths);
    state.syncPictures = () => !!options.pictures;
    const sync = new SyncService(state, reader);
    return { state, sync, workflow: new ReviewWorkflow(sync), files: new LocalReviewFiles(state) };
  }
  /** Turns the review files on, imports what agents saved there and regenerates REVIEW.md and index.json. */
  async function refreshReviewFiles(files: LocalReviewFiles, state: ProjectStore): Promise<void> {
    if ((await state.read()).reviewFiles) await files.sync(); else await files.enable();
  }
  /** Apply and Send go ahead only while the folder is linked as it was when the command read the link (checked under the folder's lock). */
  const unchanged = (file: string, raw: string) => () => { try { return readFileSync(file, 'utf8') === raw; } catch { return false; } };

  let code: number;
  try {
    code = await withOperation({ signal: controller.signal, report: message => io.err(message) }, async () => {
      switch (command) {
        case 'sign-in': {
          const baseUrl = baseUrlOf(options, io), file = sessionFile(options, io, baseUrl), executable = findBrowser(typeof options.browser === 'string' ? options.browser : undefined);
          if (!executable) throw new UsageError('No Chrome, Edge, Brave or Chromium browser was found. Pass --browser PATH, or set TURNLEAF_COOKIE.');
          await checkSessionFile(file, 'write');
          io.err('Sign in to Overleaf in the browser window. It closes once you are signed in.');
          let validated: OverleafReader | undefined;
          const cookie = await browserSignIn({ baseUrl, executable, profileDir: signInProfile(file, baseUrl), headless: !!options.headless,
            validate: async value => { const reader = new OverleafReader(baseUrl, value); try { await reader.signIn(); validated = reader; return true; } catch (error) { if (error instanceof SessionExpiredError) return false; throw error; } } });
          // The cookie as the validating reader holds it: Overleaf may have renewed it while listing the projects.
          await saveSession(file, validated?.sessionCookie || cookie);
          print(`Signed in to ${baseUrl}.`, { signedIn: true, baseUrl });
          return exitCodes.ok;
        }
        case 'projects': {
          const reader = await connect(baseUrlOf(options, io), false), projects = await reader.signIn();
          print(projects.map(project => `${project.id}  ${project.name}`).join('\n') || 'No projects.', projects);
          return exitCodes.ok;
        }
        case 'link': {
          const projectId = positional[0];
          if (!!options.files === !!options['all-sources']) throw new UsageError('Choose the files: --files a.tex,b.bib or --all-sources.');
          const baseUrl = baseUrlOf(options, io);
          let paths: string[];
          if (typeof options.files === 'string') paths = asUsage(() => validateTrackedFiles((options.files as string).split(',').map(path => path.trim()).filter(Boolean)));
          else paths = validateTrackedFiles((await (await connect(baseUrl, true)).listSourceFiles(projectId)).paths.filter(path => /\.(tex|bib|sty|cls)$/i.test(path)));
          const link: Link = { schema: 1, baseUrl, projectId, paths }, store = new ProjectStore(folder, link.baseUrl, link.projectId, link.paths);
          // exclusive creates .turnleaf/ with its .gitignore, so Git ignores cli.json from the start.
          await store.exclusive(async () => {
            await refuseSelectionChange(link);
            await atomicJson(await linkFile(folder), link);
          });
          print(`Linked ${folder} to ${projectId}: ${link.paths.join(', ')}`, link);
          return exitCodes.ok;
        }
        case 'pull': {
          const { link, raw, file } = await readLink(folder), reader = await connect(linkedServer(link, options, io), true), { state, workflow, files } = await workflowFor(link, reader);
          let plan = await workflow.preparePull();
          const conflicts = plan.files.filter(file => file.conflict).map(file => file.path), pictureConflicts = (plan.pictures ?? []).filter(picture => picture.kind === 'both' && !picture.choice).map(picture => picture.path);
          if (conflicts.length || pictureConflicts.length) {
            if (!options['take-overleaf']) throw new Blocked(`Changed both here and on Overleaf: ${[...conflicts, ...pictureConflicts].join(', ')}. Resolve them by hand, or rerun with --take-overleaf to use Overleaf's version.`, 'conflict', { conflicts, pictureConflicts });
            for (const file of plan.files.filter(file => file.conflict)) plan = workflow.resolve(plan, file.path, file.remote);
            for (const path of pictureConflicts) plan = workflow.choosePicture(plan, path, 'remote');
          }
          // As in the editor: up to date only with a sync baseline that matches Overleaf and no interrupted Send.
          // Otherwise even a plan without rows is applied, which records the baseline.
          const data = await state.read(), took = new Set([...conflicts, ...pictureConflicts]);
          const upToDate = !pullChanges(plan) && !!plan.revision && !plan.cache.partialPush && !!data.acknowledged && sameContent(data.acknowledged, plan.inspection);
          const result = { changed: !upToDate,
            files: plan.files.map(file => ({ path: file.path, added: file.added, removed: file.removed, ...took.has(file.path) && { tookOverleaf: true } })),
            pictures: (plan.pictures ?? []).map(picture => ({ path: picture.path, kind: picture.kind, ...picture.choice && { choice: picture.choice }, ...took.has(picture.path) && { tookOverleaf: true }, ...picture.note && { note: picture.note } })),
            comments: plan.comments.map(comment => ({ id: comment.id, label: comment.label, path: comment.path })) };
          const counts = `${result.files.length} file change(s), ${result.pictures.length} picture change(s) and ${result.comments.length} comment change(s)`;
          if (options['dry-run']) { print(upToDate ? 'Up to date.' : `Would apply ${counts}.`, { dryRun: true, ...result }); return exitCodes.ok; }
          if (!upToDate) await workflow.apply(plan, unchanged(file, raw));
          await refreshReviewFiles(files, state);
          const review = await files.path();
          print(upToDate ? `Up to date. Review files: ${review}` : `Applied ${counts}. Review files: ${review}`, { ...result, reviewFiles: dirname(review) });
          return exitCodes.ok;
        }
        case 'status':
        case 'send': {
          const { link, raw, file } = await readLink(folder), reader = await connect(linkedServer(link, options, io), true), { state, sync, workflow, files } = await workflowFor(link, reader);
          await refreshReviewFiles(files, state);
          let plan: PushPlan;
          try { plan = await workflow.prepareSend(); }
          finally {
            // prepareSend records what it read on Overleaf: the review files show it too, also when Send is blocked.
            try { await refreshReviewFiles(files, state); } catch (error) { warn(`could not regenerate the review files: ${safeError(error)}`); }
          }
          const problems = policyProblems(plan, { commentsOnly: !!options['comments-only'], allowUntrackedEdits: !!options['allow-untracked-edits'], allowDeletes: !!options['allow-deletes'] });
          const planned = summary(plan);
          if (command === 'status' || options['dry-run']) { print([pushReport(plan), ...problems.map(problem => `Refused: ${problem}`)].join('\n'), { dryRun: true, ...planned, problems }); return problems.length ? exitCodes.blocked : exitCodes.ok; }
          if (problems.length) throw new Blocked(problems.join('\n'), 'policy', { ...planned, problems });
          if (!planned.files.length && !planned.pictures.length && !planned.comments.length) { print(plan.incoming ? 'Nothing to send. Overleaf changed: run turnleaf pull.' : 'Nothing to send.', { sent: false, ...planned }); return exitCodes.ok; }
          const valid = unchanged(file, raw);
          // As the editor's Apply & send: Overleaf's changes are written to the folder first, then Send goes out.
          if (plan.incoming) { const applied = await workflow.apply(plan.incoming, valid); plan = workflow.afterIncoming(plan, applied); io.err(`Applied Overleaf's changes to the folder first (recovery checkpoint ${applied.checkpoint}).`); }
          const result = await sync.push(plan, valid, line => io.err(line));
          // Overleaf has it now: the receipt is printed whatever local upkeep fails after this point.
          const warnings = [...result.warnings];
          try { await refreshReviewFiles(files, state); } catch (error) { warnings.push(`Sent, but the review files could not be regenerated: ${safeError(error)}`); }
          print([`Sent. History record ${result.history}.`, ...warnings.map(warning => `Warning: ${warning}`), ...result.mismatches.map(mismatch => `Mismatch: ${mismatch}`)].join('\n'),
            { sent: true, ...planned, history: result.history, warnings, mismatches: result.mismatches });
          return result.mismatches.length ? exitCodes.failed : exitCodes.ok;
        }
        default: throw new UsageError(`Unknown command: ${command}`);
      }
    });
  } catch (error) { code = fail(error); }
  for (const keep of renewals) {
    try { await keep(); } catch (error) { warn(`could not save the session cookie Overleaf renewed (${safeError(error)}); the next command may need turnleaf sign-in.`); }
  }
  return code;

  /**
   * The state of a selection is kept by its files, so linking the same project
   * with other files leaves the queued drafts of the old selection behind, or
   * revives an older queue of the new one. Until the command line carries the
   * state over as the editor does, it refuses while either has queued drafts or
   * an interrupted sync.
   */
  async function refuseSelectionChange(next: Link): Promise<void> {
    let old: Link;
    try { old = (await readLink(folder)).link; } catch { return; }
    if (old.baseUrl !== next.baseUrl || old.projectId !== next.projectId || JSON.stringify([...old.paths].sort()) === JSON.stringify([...next.paths].sort())) return;
    for (const [which, paths] of [['current', old.paths], ['new', next.paths]] as const) {
      const data = await new ProjectStore(folder, next.baseUrl, next.projectId, paths).read();
      if (data.pending.length || data.localApply || data.partialSend)
        throw new Blocked(`The ${which} file selection (${paths.join(', ')}) of this project has ${data.pending.length ? `${data.pending.length} queued comment change(s)` : 'an interrupted sync'}. Changing the selection would ${which === 'current' ? 'leave them behind' : 'bring back that older queue'}. Send or discard them with the current selection first, or link with the same files.`, 'selection', { selection: paths, pending: data.pending.length });
    }
  }
}

const destructive = new Set(['deleteThread', 'deleteMessage']);
/** What a plan writes, in a form a script can check. Blocked pictures are listed with the reason, not sent. */
function summary(plan: PushPlan) {
  return {
    trackChanges: plan.inspection.trackChanges ?? null,
    files: plan.files.map(file => ({ path: file.doc.path, added: file.added, removed: file.removed, ...file.create && { create: true }, ...file.remove && { remove: true } })),
    pictures: (plan.pictures ?? []).filter(sendsPicture).map(picture => ({ path: picture.path, kind: picture.kind })),
    blockedPictures: (plan.pictures ?? []).filter(picture => !sendsPicture(picture)).map(picture => ({ path: picture.path, note: picture.note ?? null })),
    comments: plan.comments.map(comment => ({ id: comment.id, label: comment.label, path: comment.path, line: comment.line ?? null, threadId: comment.threadId ?? null })),
    ...plan.incoming && { incoming: plan.incoming.files.map(file => file.path) },
  };
}
/** The checks a headless Send applies on top of the core's own: refusals, never silent changes. */
export function policyProblems(plan: PushPlan, options: { commentsOnly?: boolean; allowUntrackedEdits?: boolean; allowDeletes?: boolean }): string[] {
  const problems: string[] = [], pictures = (plan.pictures ?? []).filter(sendsPicture), drafts = plan.operations ?? plan.pending;
  if (options.commentsOnly) {
    if (plan.files.length || pictures.length)
      problems.push(`--comments-only: the folder also has file changes (${[...plan.files.map(file => file.doc.path), ...pictures.map(picture => picture.path)].join(', ')}). Undo them or drop --comments-only.`);
    // Accepting or rejecting a suggestion changes the text on Overleaf directly.
    const decisions = drafts.filter(isDecision);
    if (decisions.length) problems.push(`--comments-only: ${decisions.length} suggestion decision(s) are queued (${decisions.map(draft => `${draft.kind === 'acceptChange' ? 'accept' : 'reject'} in ${draft.path}`).join(', ')}); they change the text. Discard them or drop --comments-only.`);
  }
  // On by default: without a person reviewing the summary, edits must arrive as suggestions.
  // The writer tracks an edit only with Track Changes on and a known user (overleaf.ts), and a
  // created file's content always goes in as plain text.
  if (!options.allowUntrackedEdits) {
    const tracks = plan.inspection.trackChanges === true && !!plan.inspection.userId;
    const created = plan.files.filter(file => file.create && file.text), edited = plan.files.filter(file => !file.create);
    if (edited.length && !tracks)
      problems.push(`Track Changes is off for this account in this project${plan.inspection.trackChanges === true ? ' (or Overleaf did not name the account)' : ''}, so edits would change the text directly instead of arriving as suggestions: ${edited.map(file => file.doc.path).join(', ')}. Turn Track Changes on for this account on Overleaf, send comments only, or pass --allow-untracked-edits.`);
    if (created.length)
      problems.push(`Creating ${created.map(file => file.doc.path).join(', ')} on Overleaf puts the content in as plain text, never as suggestions. Pass --allow-untracked-edits to create ${created.length === 1 ? 'it' : 'them'}.`);
  }
  if (!options.allowDeletes) {
    const deletions = [...drafts.filter(draft => destructive.has(draft.kind)).map(draft => `${draft.kind} ${draft.id}`),
      ...plan.files.filter(file => file.remove).map(file => `delete ${file.doc.path}`), ...pictures.filter(picture => picture.kind === 'delete').map(picture => `delete ${picture.path}`)];
    if (deletions.length) problems.push(`Deletions need --allow-deletes: ${deletions.join(', ')}.`);
  }
  return problems;
}

if (require.main === module) {
  run(process.argv.slice(2), { out: line => process.stdout.write(line + '\n'), err: line => process.stderr.write(line + '\n'), env: process.env, cwd: process.cwd() })
    .then(code => { process.exitCode = code; });
}
