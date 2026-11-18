// How a live session reacts to a realtime event from Overleaf. Unknown names
// are treated as possible comment changes: re-reading the comment list is cheap,
// and the periodic full check catches anything this list misses.
export type LiveEventKind = 'ignore' | 'update' | 'reconnect';

const ignored = new Set([
  'connectionAccepted', 'joinProjectResponse', 'clientTracking.clientUpdated', 'clientTracking.clientDisconnected', 'clientTracking.refresh',
  'compilerUpdated', 'spellCheckLanguageUpdated', 'imageNameUpdated', 'project:publicAccessLevel:changed', 'mainBibliographyDocUpdated',
]);
// The project tree, Track Changes state or the connection itself changed:
// the session's file IDs and settings are stale, so it is reopened.
const reconnect = new Set([
  'reciveNewDoc', 'reciveNewFile', 'reciveNewFolder', 'removeEntity', 'reciveEntityRename', 'reciveEntityMove', 'projectNameUpdated',
  'rootDocUpdated', 'toggle-track-changes', 'otUpdateError', 'forceDisconnect', 'reconnectGracefully', 'project:membership:changed',
]);

export function classifyLiveEvent(name: string): LiveEventKind {
  return ignored.has(name) ? 'ignore' : reconnect.has(name) ? 'reconnect' : 'update';
}
