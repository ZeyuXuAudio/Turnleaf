// The words the extension shows for its sync state: the panel's state line, the
// status bar item, diff tab titles, freshness and send outcomes. Pure, so the
// scripted demos in scripts/demos render the same text as the extension.

export const SENT_VERIFIED = 'Sent and verified on Overleaf.';
export const UNDO_SENT_VERIFIED = 'Undo sent and verified on Overleaf. Your local files keep the edits, now listed as going out.';
export const LOCAL_APPLIED = 'Local updates applied. Your unsent edits were preserved.';
export const REVIEW_FILES_IMPORTED = 'Comment JSON saved as local drafts, listed as going out.';

export const FRESHNESS = {
  unchecked: 'Remote state not checked',
  justChecked: 'Checked just now',
  incoming: 'Incoming updates available',
  live: 'Live · up to date',
  quiet: 'No new remote changes',
} as const;

export type Session = 'unknown' | 'valid' | 'expired' | 'signedOut';

export interface StateInput {
  reviewFilesError?: string;
  localApply?: boolean;
  /** The Get latest preview, if one is open. */
  preview?: { stale?: string; complete?: string; conflicts?: boolean; kept?: boolean };
  partialPush?: boolean;
  session: Session;
  undo?: { notice?: string; blocked?: boolean };
  checking?: boolean;
  cached?: boolean;
  inspected: boolean;
  /** A sync service is set up for a linked project with chosen files. */
  serviceReady: boolean;
  linkedWithoutFiles?: boolean;
  /** The outgoing summary: its notice, row counts, incoming part and block. */
  standing?: { notice?: string; files: number; comments: number; incoming?: boolean; blocked?: boolean };
  needsPull?: boolean;
  note?: string;
}

/** The panel's state line, and the status bar tooltip's first line. */
export function stateLabel(s: StateInput): string {
  const p = s.preview, signedOut = s.session === 'expired' || s.session === 'signedOut';
  if (s.reviewFilesError) return `Local review files: ${s.reviewFilesError}`;
  if (s.localApply) return 'Local update interrupted. Recover the saved checkpoint before continuing.';
  if (p?.stale) return `Preview out of date: ${p.stale}`;
  if (p?.complete) return p.complete;
  if (p) return p.conflicts ? 'Resolve conflicts in the preview before applying.' : p.kept ? 'Apply updates. Your kept files are then listed as going out.' : 'Review the proposed files and comments, then Apply updates.';
  if (s.partialPush && signedOut) return 'Send was interrupted. Sign in, then Get latest to check what reached Overleaf.';
  if (signedOut) return 'Sign in to refresh or synchronize. Cached comments remain available.';
  if (s.partialPush) return 'Send was interrupted. Get latest to check what reached Overleaf.';
  if (s.undo) return s.undo.notice ?? (s.undo.blocked ? 'This send cannot be undone now.' : 'Check what is taken back from Overleaf, then Send undo.');
  if (s.checking && (s.cached || !s.inspected)) return 'Checking Overleaf…';
  if (s.cached && s.inspected) return 'Cached comments may be stale. Refresh before reviewing remote changes.';
  if (!s.serviceReady && !s.inspected && s.linkedWithoutFiles) return 'Project linked. Choose the source files to synchronize.';
  if (!s.inspected) return s.serviceReady ? 'Project linked. Get latest to review incoming changes.' : 'Connect to an Overleaf project to get started.';
  if (s.standing?.notice) return s.standing.notice;
  const files = s.standing?.files ?? 0, comments = s.standing?.comments ?? 0;
  if (s.needsPull) return files + comments && s.standing?.incoming ? 'Overleaf changed too. Apply & send merges those changes into your files first; Get latest previews them.' : 'Incoming changes available. Get latest to review them.';
  if (s.note) return s.note;
  if (s.standing?.blocked) return 'Nothing can be sent yet.';
  const unsent = [...files ? [`${files} ${files === 1 ? 'file' : 'files'}`] : [], ...comments ? [`${comments} comment ${comments === 1 ? 'change' : 'changes'}`] : []];
  return unsent.length ? `Not sent yet: ${unsent.join(', ')}.` : 'Up to date with Overleaf.';
}

export interface StatusInput {
  session: Session;
  localApply?: boolean;
  preview?: { stale?: string; complete?: string };
  partialPush?: boolean;
  reconciliation?: boolean;
  checking?: boolean;
  cached?: boolean;
  inspected: boolean;
  freshness: string;
  needsPull?: boolean;
  note?: string;
  open: number;
  suggestions: number;
  unsent: number;
}

/** The status bar item's text, with codicons as `$(name)`. */
export function statusText(s: StatusInput): string {
  const p = s.preview;
  const warning = s.session === 'expired' || !!s.partialPush || !!s.reconciliation || !!s.needsPull;
  const suffix = s.session === 'expired' ? 'session expired' : s.session === 'signedOut' ? 'signed out' : s.localApply ? 'recovery needed' : p?.stale ? 'review out of date' : p && !p.complete ? 'review ready' : s.partialPush ? 'Get latest required' : s.reconciliation ? 'reconciliation pending' : s.checking ? 'checking' : s.cached && s.inspected ? 'cached' : s.freshness.startsWith('Remote state unknown') ? 'offline · retrying' : s.needsPull ? 'incoming changes' : s.note;
  return `${warning ? '$(warning) ' : ''}Overleaf: ${s.inspected ? `${s.open} open · ${s.suggestions} ${s.suggestions === 1 ? 'suggestion' : 'suggestions'}` : 'ready'}${s.unsent ? ` · $(arrow-up)${s.unsent}` : ''}${suffix ? ` · ${suffix}` : ''}`;
}

export type DiffKind = 'merge' | 'send' | 'undo';
/** The two virtual documents of a file-text diff. */
export const diffSides: Record<DiffKind, [string, string]> = {
  merge: ['Local-current', 'Local-after-merge'],
  send: ['Overleaf-current', 'Overleaf-after-send'],
  undo: ['Overleaf-current', 'Overleaf-after-undo'],
};
const diffWords: Record<DiffKind, string> = { merge: 'local → after merge', send: 'Overleaf now → after send', undo: 'Overleaf now → after undo' };
/** A diff's title, as for a picture comparison. */
export const diffTitle = (path: string, kind: DiffKind, stale = false) => `${stale ? 'Out of date · ' : ''}${path} · ${diffWords[kind]}`;
/** The editor tab title of a file-text diff. */
export const diffTabTitle = (path: string, kind: DiffKind, stale = false) => `${diffTitle(path, kind, stale)} (file text)`;

/** The note on a diff line where a comment change applies. */
export function commentNote(change: { label: string; before?: { messages: { id?: string; text: string }[] }; after?: { messages: { id?: string; text: string }[] } }, incoming: boolean): string {
  const text = change.after?.messages.find(message => !change.before?.messages.some(old => old.id === message.id && old.text === message.text))?.text;
  return `${change.label}${incoming ? ' from Overleaf' : ' on send'}${text ? `: “${text.length > 60 ? text.slice(0, 59) + '…' : text}”` : ''}`;
}
