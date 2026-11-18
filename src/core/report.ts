import { Anchor, Inspection } from './models';

export function anchorStateLabel(state: Anchor['state']): string {
  return state === 'hidden' ? 'anchor in a suggested deletion' : state;
}

function literal(text: unknown): string {
  return String(text ?? '').replace(/[\r\n]/g, ' ').replace(/[\\`*_{}\[\]()<>#!|]/g, '\\$&');
}
export function inspectionCounts(inspection: Inspection): { open: number; suggestions: number } {
  const ids = new Set(inspection.docs.flatMap(doc => doc.comments.map(c => c.threadId)));
  return { open: [...ids].filter(id => inspection.threads[id] && !inspection.threads[id].resolved).length,
    suggestions: inspection.docs.reduce((n, doc) => n + doc.changes.length, 0) };
}
export function renderInspection(inspection: Inspection): string {
  const counts = inspectionCounts(inspection);
  const lines = [`# Overleaf inspection: ${literal(inspection.projectName)}`, '', `Fetched: ${inspection.fetchedAt}`, '',
    'Read-only inspection. Positions below refer to the fetched Overleaf text, with suggestions accepted. Local files and Overleaf content are unchanged.', '',
    `${counts.open} open threads · ${counts.suggestions} suggestions in the tracked files.`, '',
    'Use “Turnleaf: Open Inspected File” to view the fetched text and its comment threads.', ''];
  for (const path of inspection.missingFiles) lines.push(`Not fetched: ${literal(path)} (missing or not a text document).`, '');
  if (inspection.unassignedThreadCount) lines.push(`${inspection.unassignedThreadCount} other project thread${inspection.unassignedThreadCount === 1 ? '' : 's'} could not be assigned to the tracked files in this inspection.`, '');
  for (const doc of inspection.docs) {
    lines.push(`## ${literal(doc.path)}`, '', `${doc.otType} · version ${doc.version} · ${doc.comments.length} thread${doc.comments.length === 1 ? '' : 's'} · ${doc.changes.length} suggestion${doc.changes.length === 1 ? '' : 's'}`, '');
    for (const diagnostic of doc.diagnostics) lines.push(`Warning: ${literal(diagnostic)}`, '');
    for (const anchor of doc.comments) {
      const thread = inspection.threads[anchor.threadId];
      const line = anchor.ranges.length ? doc.text.slice(0, anchor.ranges[0].pos).split('\n').length : undefined;
      lines.push(`### ${literal(anchor.threadId)} · ${thread ? thread.resolved ? 'resolved' : 'open' : 'messages unavailable'} · ${anchorStateLabel(anchor.state)}${line ? ` · line ${line}` : ''}`, '');
      for (const message of thread?.messages ?? []) lines.push(`${literal(message.author)} · ${literal(message.timestamp)}`, '', ...message.text.split(/\r?\n/).map(line => `> ${literal(line)}`), '');
    }
    for (const change of doc.changes) {
      lines.push(`Suggestion: ${change.kind} · ${literal(change.author)} · ${literal(change.timestamp)} · line ${doc.text.slice(0, change.pos).split('\n').length}`, '', `> ${literal(change.text)}`, '');
    }
  }
  return lines.join('\n');
}
