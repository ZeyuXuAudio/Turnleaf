import { createHash, randomBytes } from 'node:crypto';
import { rename, writeFile } from 'node:fs/promises';
import type { Inspection, Project } from '../src/core/models';

// Shared by the live roundtrip test (scripts/roundtrip.mjs): its arguments, the name guard
// that keeps it away from real papers, the marker strings it writes, the project state it
// compares before and after, and the result file. No editor and no network here, so
// test/roundtrip.test.ts checks all of it offline.

/** Only a project whose name starts with this is ever written to. */
export const NAME_PREFIX = 'Turnleaf test';
/** Every comment, reply and edit the test writes starts with this, so leftovers can be found. */
export const MARKER_PREFIX = 'turnleaf-roundtrip';
export const fixtureProject = 'test-project';

export class UsageError extends Error {}

export interface RoundtripOptions {
  /** Open the sign-in window first. */
  setup: boolean;
  /** Never open the sign-in window by itself. */
  noSetup: boolean;
  project?: string;
  /** The extension leg in VS Code (default on). */
  extension: boolean;
  /** The command-line leg through dist/cli.js (default on). */
  cli: boolean;
  /** A session file the owner saved for the command-line leg; otherwise the editor profile's session is used. */
  sessionFile?: string;
  /** Against the local fixture server, with a temporary profile: no Overleaf account involved. */
  fixture: boolean;
  help: boolean;
}

export const usage = `Usage: npm run test:roundtrip -- [options]

Writes to a real Overleaf project, then removes what it wrote. Only a project whose name
starts with "${NAME_PREFIX}" is written to.

  --project ID        The test project (or TURNLEAF_ROUNDTRIP_PROJECT).
  --setup             Open the sign-in window first (needed once).
  --no-setup          Never open the sign-in window by itself.
  --no-cli            Skip the command-line leg.
  --cli               Run the command-line leg (the default).
  --no-extension      Skip the extension leg (the command-line leg then needs --session-file).
  --session-file F    A command-line session file to use instead of the editor profile's session
                      (or TURNLEAF_ROUNDTRIP_SESSION_FILE).
  --fixture           Run against the local fixture server instead of overleaf.com.
  --help              Show this help.

Environment: TURNLEAF_EDITOR (default VS Code), TURNLEAF_ROUNDTRIP_PROFILE (default
~/Library/Caches/turnleaf-roundtrip).`;

const flags: Record<string, (o: RoundtripOptions) => void> = {
  setup: o => { o.setup = true; }, 'no-setup': o => { o.noSetup = true; },
  cli: o => { o.cli = true; }, 'no-cli': o => { o.cli = false; },
  'no-extension': o => { o.extension = false; }, fixture: o => { o.fixture = true; }, help: o => { o.help = true; },
};
const valued = new Set(['project', 'session-file']);

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = {}): RoundtripOptions {
  const options: RoundtripOptions = { setup: false, noSetup: false, extension: true, cli: true, fixture: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new UsageError(`Unexpected argument: ${arg}. Pass the project as --project ID.`);
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
    if (flags[name]) { if (inline !== undefined) throw new UsageError(`--${name} takes no value.`); flags[name](options); continue; }
    if (!valued.has(name)) throw new UsageError(`Unknown option: --${name}.`);
    const value = inline ?? argv[++i];
    if (value === undefined || value === '' || value.startsWith('--')) throw new UsageError(`--${name} needs a value.`);
    if (name === 'project') options.project = value; else options.sessionFile = value;
  }
  if (options.help) return options;
  if (options.setup && options.noSetup) throw new UsageError('Choose --setup or --no-setup, not both.');
  if (!options.extension && !options.cli) throw new UsageError('--no-extension and --no-cli leave nothing to run.');
  options.project ??= env.TURNLEAF_ROUNDTRIP_PROJECT?.trim() || (options.fixture ? fixtureProject : undefined);
  options.sessionFile ??= env.TURNLEAF_ROUNDTRIP_SESSION_FILE?.trim() || undefined;
  if (!options.project) throw new UsageError('Name the test project: --project ID, or set TURNLEAF_ROUNDTRIP_PROJECT.');
  if (!options.fixture && !/^[0-9a-f]{24}$/i.test(options.project)) throw new UsageError('The project ID is the 24-character hexadecimal part of the project URL (overleaf.com/project/<ID>).');
  if (!options.extension && !options.sessionFile && !options.fixture) throw new UsageError('--no-extension needs --session-file: the command-line leg takes the session from the editor profile otherwise.');
  return options;
}

export interface GuardResult { passed: boolean; check: string; reason?: 'not-in-project-list' | 'name-does-not-match' | 'names-differ' }
/**
 * The test's main safety check, run before any write: the project must be in the account's
 * list under a name that starts with NAME_PREFIX, and the project page must give the same
 * name. A refused name is never recorded, since it may be a real paper's.
 */
export function nameGuard(projectId: string, projects: Project[], pageName?: string): GuardResult {
  const check = `project name starts with "${NAME_PREFIX}"`;
  const listed = projects.find(project => project.id === projectId);
  if (!listed) return { passed: false, check, reason: 'not-in-project-list' };
  if (typeof listed.name !== 'string' || !listed.name.startsWith(NAME_PREFIX)) return { passed: false, check, reason: 'name-does-not-match' };
  if (pageName !== undefined && pageName !== listed.name) return { passed: false, check, reason: 'names-differ' };
  return { passed: true, check };
}

export function newRunId(now = new Date()): string {
  return `${now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${randomBytes(2).toString('hex')}`;
}
export type Leg = 'extension' | 'cli';
/** The test's own strings: the only text it writes to Overleaf or into its result. */
export function markers(runId: string, leg: Leg) {
  const base = `${MARKER_PREFIX} ${runId} ${leg}`;
  return { comment: `${base} comment`, reply: `${base} reply`, edit: `% ${base} edit`, id: `${MARKER_PREFIX}-${runId}-${leg}`.replace(/[^\w-]/g, '-') };
}

/** What "ends as it started" compares: per file a text hash and counts, and the project's threads. No text. */
export interface ProjectState {
  docs: Record<string, { sha256: string; suggestions: number; comments: number }>;
  threads: { total: number; resolved: number; messages: number };
}
export function projectState(inspection: Inspection): ProjectState {
  const docs: ProjectState['docs'] = {};
  for (const doc of [...inspection.docs].sort((a, b) => a.path.localeCompare(b.path)))
    docs[doc.path] = { sha256: createHash('sha256').update(doc.text).digest('hex'), suggestions: doc.changes.length, comments: doc.comments.length };
  const threads = Object.values(inspection.threads);
  return { docs, threads: { total: threads.length, resolved: threads.filter(thread => thread.resolved).length, messages: threads.reduce((n, thread) => n + thread.messages.length, 0) } };
}
/** The differences between two states, by file and field (no values beyond counts). */
export function stateDifferences(before: ProjectState, after: ProjectState): string[] {
  const out: string[] = [];
  for (const path of new Set([...Object.keys(before.docs), ...Object.keys(after.docs)])) {
    const a = before.docs[path], b = after.docs[path];
    if (!a || !b) { out.push(`${path}: ${a ? 'missing now' : 'new'}`); continue; }
    if (a.sha256 !== b.sha256) out.push(`${path}: text differs`);
    if (a.suggestions !== b.suggestions) out.push(`${path}: suggestions ${a.suggestions} → ${b.suggestions}`);
    if (a.comments !== b.comments) out.push(`${path}: comment anchors ${a.comments} → ${b.comments}`);
  }
  for (const key of ['total', 'resolved', 'messages'] as const)
    if (before.threads[key] !== after.threads[key]) out.push(`threads ${key}: ${before.threads[key]} → ${after.threads[key]}`);
  return out;
}

const marked = (text: string | undefined) => typeof text === 'string' && text.replace(/^%\s*/, '').startsWith(MARKER_PREFIX);
/** What the test (this run or an earlier one) left on Overleaf: its threads, its suggestions, and files whose text holds a marker outside a suggestion. */
export function leftovers(inspection: Inspection) {
  const threads = Object.entries(inspection.threads).filter(([, thread]) => marked(thread.messages[0]?.text)).map(([id]) => id);
  const suggestions = inspection.docs.flatMap(doc => doc.changes.filter(change => change.kind === 'insert' && change.text.includes(MARKER_PREFIX)).map(change => ({ path: doc.path, id: change.id })));
  const directText = inspection.docs.filter(doc => {
    const inSuggestions = doc.changes.filter(change => change.kind === 'insert').reduce((n, change) => n + count(change.text), 0);
    return count(doc.text) > inSuggestions;
  }).map(doc => doc.path);
  return { threads, suggestions, directText };
}
const count = (text: string) => text.split(MARKER_PREFIX).length - 1;
export const leftoverCounts = (found: ReturnType<typeof leftovers>) => ({ threads: found.threads.length, suggestions: found.suggestions.length, directText: found.directText.length });
export const nothingLeft = (found: ReturnType<typeof leftovers>) => !found.threads.length && !found.suggestions.length && !found.directText.length;
/** The thread whose first message is exactly `text`. */
export function threadWithFirstMessage(inspection: Inspection, text: string): string | undefined {
  return Object.entries(inspection.threads).find(([, thread]) => thread.messages[0]?.text === text)?.[0];
}

/**
 * A line of the source to comment on: the first line, at least 8 characters long once
 * trimmed, that occurs once in the file. Its text stays in memory only.
 */
export function commentQuote(text: string): string | undefined {
  for (const line of text.split('\n')) {
    const quote = line.trim();
    if (quote.length >= 8 && !quote.includes(MARKER_PREFIX) && text.split(quote).length === 2) return quote;
  }
  return undefined;
}
/** The text with the marker line appended, so that rejecting the insertion restores it exactly. */
export function withEditLine(text: string, line: string): string {
  return text.endsWith('\n') || !text ? `${text}${line}\n` : `${text}\n${line}`;
}

export type StepOutcome = 'passed' | 'failed' | 'skipped';
export type Detail = Record<string, string | number | boolean | null | string[]>;
export interface StepRecord { leg: Leg | 'runner'; name: string; outcome: StepOutcome; durationMs: number; detail?: Detail; reason?: string; error?: string }
/** A step that failed with this error records the error's message (limited in length). */
export class StepFailure extends Error { constructor(message: string, readonly detail?: Detail) { super(message); } }

export class Steps {
  readonly list: StepRecord[] = [];
  constructor(private readonly leg: StepRecord['leg']) {}
  /** Runs one step; returns its value, or undefined after a failure (which is recorded, not thrown). */
  async run<T>(name: string, action: () => Promise<{ value?: T; detail?: Detail } | void>): Promise<T | undefined> {
    const started = Date.now();
    try {
      const result = await action() ?? {};
      this.list.push({ leg: this.leg, name, outcome: 'passed', durationMs: Date.now() - started, ...result.detail && { detail: result.detail } });
      return result.value;
    } catch (error) {
      this.list.push({ leg: this.leg, name, outcome: 'failed', durationMs: Date.now() - started, error: errorText(error), ...error instanceof StepFailure && error.detail && { detail: error.detail } });
      return undefined;
    }
  }
  skip(name: string, reason: string, detail?: Detail): void { this.list.push({ leg: this.leg, name, outcome: 'skipped', durationMs: 0, reason, ...detail && { detail } }); }
  get failed(): boolean { return this.list.some(step => step.outcome === 'failed'); }
}
export const errorText = (error: unknown) => (error instanceof Error ? error.message : 'Unexpected failure.').slice(0, 400);

/**
 * Writes the result atomically. Every string in `secrets` (the session cookie, when the
 * caller holds it) is replaced before writing, as a last line of defence: the result is
 * built from counts and outcomes and should never hold one.
 */
export async function writeResult(path: string, result: object, secrets: (string | undefined)[] = []): Promise<string> {
  let json = JSON.stringify(result, null, 2) + '\n';
  for (const secret of secrets) if (secret && secret.length >= 8) json = json.split(secret).join('[redacted]');
  await writeFile(path + '.partial', json, { mode: 0o600 });
  await rename(path + '.partial', path);
  return json;
}

export type RunStatus = 'passed' | 'failed' | 'incomplete' | 'refused' | 'setup-required' | 'session-expired';
/** Passed only when the guard passed, every step passed (none skipped) and the cleanup completed. */
export function overallStatus(input: { guardPassed?: boolean; steps: StepRecord[]; cleanupCompleted: boolean; stop?: RunStatus }): RunStatus {
  if (input.stop) return input.stop;
  if (input.guardPassed === false) return 'refused';
  if (input.steps.some(step => step.outcome === 'failed') || !input.cleanupCompleted || input.guardPassed !== true) return 'failed';
  if (input.steps.some(step => step.outcome === 'skipped')) return 'incomplete';
  return 'passed';
}
