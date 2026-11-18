// Text helpers shared by the project view, Sync history and editor hovers.
export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
export const initials = (name: string) => name.replace(/[^\p{L}\p{N}\s.]/gu, '').split(/[\s.]+/).filter(Boolean).slice(0, 2).map(part => part[0]!.toUpperCase()).join('') || '?';
/** "Oct 17, 16:17" in the user's local timezone, or '' for an invalid timestamp. */
export const shortDateTime = (timestamp?: string | number) => {
  const date = timestamp === undefined ? undefined : new Date(timestamp);
  return date && Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '';
};
export const clip = (text: string, length: number) => text.length > length ? text.slice(0, length - 1) + '…' : text;
