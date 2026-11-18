import { Anchor, Inspection } from './models';
import { safeError, SyncError } from './errors';

// Sanitized summaries for the live read-only probe (scripts/live.mjs). They keep
// protocol shapes and counts only: no text, comment bodies, names, values or IDs.
export interface ReadObserver { joinProject?(response: unknown): void; projectPage?(tags: Map<string, string>): void; }

export type Shape =
  | { type: 'null' | 'boolean' | 'number' | 'string' | 'other' }
  | { type: 'array'; length: number; items: Shape[] }
  | { type: 'object'; keys: string[]; objectIdKeys: number; otherKeys: number; values: Shape[] };
export interface JoinProjectSummary {
  responseKeys: string[]; projectKeys: string[];
  trackChangesFields: Record<string, Shape>; trackChangesHasOwnerKey?: boolean;
  // Q6: the type of `trackChangesState`, and whether the signed-in user's ID (from the
  // project page) is one of its keys when it is a per-user object.
  trackChangesState: 'missing' | 'boolean' | 'object' | 'other'; trackChangesHasUserKey?: boolean;
  rootDoc?: string;
}
export interface ProjectPageSummary { userIdMetaTag: boolean; userIdIsObjectId: boolean; }
export interface DocSummary {
  path: string; otType: string; version: number; threads: number;
  anchors: Record<Anchor['state'], number>; threadStatus: { open: number; resolved: number; unavailable: number };
  suggestions: { insert: number; delete: number }; warnings: Record<string, number>;
}
export interface InspectionSummary {
  docs: DocSummary[]; missingFiles: number; unassignedThreads: number;
  projectThreads: { total: number; open: number; resolved: number; messages: number };
}
export interface ErrorSummary { code: string; status?: number; message: string; }
export interface CommandOutcome {
  command: string; startedAt: string; durationMs: number; error?: ErrorSummary; inspection?: InspectionSummary; joinProject?: JoinProjectSummary;
}
export interface ProbeSnapshot { signedInAt?: string; projectPage?: ProjectPageSummary; joinProject?: JoinProjectSummary; outcomes: CommandOutcome[]; }

const objectId = /^[0-9a-f]{24}$/i;
// Letters only: schema field names are listed, anything that could be an ID, email or name is counted.
const schemaKey = /^[A-Za-z_$]{1,48}$/;
const listed = (keys: string[]) => keys.filter(key => !objectId.test(key) && schemaKey.test(key)).sort();
const unique = (shapes: Shape[]) => [...new Map(shapes.map(shape => [JSON.stringify(shape), shape])).values()];
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export function describeShape(value: unknown, depth = 3): Shape {
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) return { type: 'array', length: value.length, items: depth ? unique(value.map(item => describeShape(item, depth - 1))) : [] };
  const object = record(value);
  if (object) {
    const keys = Object.keys(object), names = listed(keys);
    const objectIdKeys = keys.filter(key => objectId.test(key)).length;
    return { type: 'object', keys: names, objectIdKeys, otherKeys: keys.length - names.length - objectIdKeys,
      values: depth ? unique(Object.values(object).map(item => describeShape(item, depth - 1))) : [] };
  }
  return { type: ['boolean', 'number', 'string'].includes(typeof value) ? typeof value as 'boolean' | 'number' | 'string' : 'other' };
}

// The path of the project's root doc, so the probe can read it when no tracked file exists.
function rootDocPath(project: Record<string, unknown>): string | undefined {
  const find = (folder: unknown, parent: string): string | undefined => {
    const value = record(folder);
    if (!value) return;
    for (const doc of Array.isArray(value.docs) ? value.docs : []) {
      if (record(doc)?._id === project.rootDoc_id && typeof doc.name === 'string') return parent + doc.name;
    }
    for (const child of Array.isArray(value.folders) ? value.folders : []) {
      const found = typeof record(child)?.name === 'string' ? find(child, parent + child.name + '/') : undefined;
      if (found) return found;
    }
  };
  if (typeof project.rootDoc_id !== 'string') return;
  for (const root of Array.isArray(project.rootFolder) ? project.rootFolder : []) {
    const found = find(root, '');
    if (found) return found;
  }
}

export function summarizeJoinProject(response: unknown, userId?: string): JoinProjectSummary {
  const payload = record(response) ?? {}, project = record(payload.project) ?? {};
  const trackChangesFields: Record<string, Shape> = {};
  for (const key of listed(Object.keys(project)).filter(key => /track/i.test(key))) trackChangesFields[key] = describeShape(project[key]);
  const state = project.trackChangesState;
  const summary: JoinProjectSummary = { responseKeys: listed(Object.keys(payload)), projectKeys: listed(Object.keys(project)), trackChangesFields,
    trackChangesState: state === undefined ? 'missing' : typeof state === 'boolean' ? 'boolean' : record(state) ? 'object' : 'other' };
  // A per-user Track Changes state is an object keyed by user IDs; report only whether the owner and the user are among them.
  const trackChanges = Object.keys(trackChangesFields).map(key => record(project[key])).find(Boolean), owner = record(project.owner)?._id;
  if (trackChanges && typeof owner === 'string') summary.trackChangesHasOwnerKey = Object.prototype.hasOwnProperty.call(trackChanges, owner);
  const own = record(state);
  if (own && userId) summary.trackChangesHasUserKey = Object.prototype.hasOwnProperty.call(own, userId);
  const rootDoc = rootDocPath(project);
  if (rootDoc) summary.rootDoc = rootDoc;
  return summary;
}

export function summarizeInspection(inspection: Inspection): InspectionSummary {
  const threads = Object.values(inspection.threads);
  return {
    docs: inspection.docs.map(doc => {
      const count = <T extends string>(values: T[], keys: T[]) => Object.fromEntries(keys.map(key => [key, values.filter(value => value === key).length])) as Record<T, number>;
      const status = doc.comments.map(anchor => { const thread = inspection.threads[anchor.threadId]; return thread ? thread.resolved ? 'resolved' : 'open' : 'unavailable'; });
      const warnings: Record<string, number> = {};
      for (const diagnostic of doc.diagnostics) {
        const kind = diagnostic.replace(/^Thread [^:]*: /, '').replace(/[.;].*$/, '');
        const key = /^[a-z -]{1,60}$/i.test(kind) ? kind : 'other';
        warnings[key] = (warnings[key] ?? 0) + 1;
      }
      return { path: doc.path, otType: doc.otType, version: doc.version, threads: doc.comments.length,
        anchors: count(doc.comments.map(anchor => anchor.state), ['placed', 'hidden', 'anchor removed', 'position unknown']),
        threadStatus: count(status, ['open', 'resolved', 'unavailable']),
        suggestions: count(doc.changes.map(change => change.kind), ['insert', 'delete']), warnings };
    }),
    missingFiles: inspection.missingFiles.length, unassignedThreads: inspection.unassignedThreadCount,
    projectThreads: { total: threads.length, open: threads.filter(thread => !thread.resolved).length,
      resolved: threads.filter(thread => thread.resolved).length, messages: threads.reduce((n, thread) => n + thread.messages.length, 0) },
  };
}

export function summarizeError(error: unknown): ErrorSummary {
  return error instanceof SyncError ? { code: error.code, ...error.status !== undefined && { status: error.status }, message: safeError(error) }
    : { code: 'unexpected', message: safeError(error) };
}

// Enabled only for the live probe in an extension development host; see extension.ts.
export class ProbeRecorder implements ReadObserver {
  private signedInAt?: string;
  // Held in memory only, to answer Q6; never part of a snapshot.
  private userId?: string;
  private lastProjectPage?: ProjectPageSummary;
  private lastJoinProject?: JoinProjectSummary;
  private pendingJoinProject?: JoinProjectSummary;
  private pending?: InspectionSummary;
  private readonly outcomes: CommandOutcome[] = [];
  joinProject(response: unknown): void { this.lastJoinProject = this.pendingJoinProject = summarizeJoinProject(response, this.userId); }
  projectPage(tags: Map<string, string>): void {
    let userId = tags.get('ol-user_id');
    // Some `ol-` meta values are JSON-encoded.
    try { const parsed = userId?.startsWith('"') ? JSON.parse(userId) : userId; if (typeof parsed === 'string') userId = parsed; } catch { /* plain value */ }
    this.userId = userId || undefined;
    this.lastProjectPage = { userIdMetaTag: Boolean(userId), userIdIsObjectId: objectId.test(userId ?? '') };
  }
  signedIn(): void { this.signedInAt = new Date().toISOString(); }
  inspected(inspection: Inspection): void { this.pending = summarizeInspection(inspection); }
  finished(command: string, started: Date, error?: unknown): void {
    const outcome: CommandOutcome = { command, startedAt: started.toISOString(), durationMs: Date.now() - started.getTime() };
    if (error !== undefined) outcome.error = summarizeError(error);
    else if (this.pending) outcome.inspection = this.pending;
    if (this.pendingJoinProject) outcome.joinProject = this.pendingJoinProject;
    this.pending = this.pendingJoinProject = undefined;
    this.outcomes.push(outcome);
  }
  snapshot(): ProbeSnapshot {
    return structuredClone({ signedInAt: this.signedInAt, projectPage: this.lastProjectPage, joinProject: this.lastJoinProject, outcomes: this.outcomes });
  }
}
