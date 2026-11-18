export interface Project { id: string; name: string; lastUpdated?: string; }
export interface Message { id?: string; author: string; authorId?: string; timestamp?: string | number; text: string; }
export interface Thread { id: string; resolved: boolean; messages: Message[]; }
export interface Range { pos: number; length: number; }
export interface Anchor {
  threadId: string; ranges: Range[]; state: 'placed' | 'hidden' | 'anchor removed' | 'position unknown';
  // Valid history-ot ranges before projection, including anchors hidden by tracked deletions.
  rawRanges?: Range[];
}
export interface Suggestion { id: string; kind: 'insert' | 'delete'; pos: number; text: string; author: string; authorId?: string; timestamp?: string | number; }
export interface DocState {
  path: string; docId: string; otType: 'sharejs-text-ot' | 'history-ot'; version: number;
  text: string; comments: Anchor[]; changes: Suggestion[]; diagnostics: string[];
  folderId?: string;
  rawContent?: string;
  rawChanges?: { range: Range; tracking: { type: 'insert' | 'delete'; userId: string; ts?: string | number } }[];
}
export interface Inspection {
  projectId: string; projectName: string; fetchedAt: string; docs: DocState[];
  threads: Record<string, Thread>; missingFiles: string[]; unassignedThreadCount: number;
  trackChanges?: boolean;
  userId?: string;
  /** The project tree beyond the selected documents: folder IDs by path ('' is the root folder) and the paths of non-text files. */
  tree?: ProjectTree;
  /** The server's upload limit in bytes (`maxUploadSize` of `ol-ExposedSettings`), when the project page gave it. */
  maxUploadSize?: number;
}
/** Folder IDs by path ('' is the root folder), text documents' IDs by path, and paths of other files (figures and other binary files). */
export interface ProjectTree { folders: Record<string, string>; docs?: Record<string, string>; files: string[];
  /** Each non-text file by path: its file ID, the Git blob SHA-1 of its content (`hash`), and whether it is linked from another project or a URL. */
  fileRefs?: Record<string, RemoteFile>; }
/** A non-text file on Overleaf. `hash`: the Git blob SHA-1 of its bytes, absent when the tree did not give one. */
export interface RemoteFile { id: string; hash?: string; linked: boolean; folderId?: string; }
