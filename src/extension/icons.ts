// Small outline icons shared by the project view. No icon fonts or remote assets.
const paths = {
  check: '<path d="m3 8 3 3 7-7"/>',
  down: '<path d="M8 2v11m-4-4 4 4 4-4"/>',
  up: '<path d="M8 14V3m-4 4 4-4 4 4"/>',
  refresh: '<path d="M13 6a5 5 0 1 0 .1 4M13 2v4H9"/>',
  comment: '<path d="M3 2.5h10a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6l-4 3v-11a1 1 0 0 1 1-1Z"/>',
  commentAdd: '<path d="M3 2.5h10a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6l-4 3v-11a1 1 0 0 1 1-1ZM8 5v4M6 7h4"/>',
  file: '<path d="M3 1.5h6l4 4v9H3zM9 1.5v4h4M5.5 8h5m-5 3h5"/>',
  // Side-by-side panes, distinct from the file glyph at 16 px.
  diff: '<rect x="2" y="2.5" width="12" height="11" rx="1"/><path d="M8 2.5v11M3.5 8h3m3 0h3M11 6.5v3"/>',
  suggestion: '<path d="M10.5 2.5 13.5 5.5 6 13H3v-3zM9 4l3 3"/>',
  // Mirror of refresh with clock hands; the plain clock means "last checked".
  history: '<path d="M3 6a5 5 0 1 1-.1 4M3 2v4h4M7.5 5v3l2 1.5"/>',
  external: '<path d="M9 2h5v5m0-5L7 9M6 3H2v11h11v-4"/>',
  settings: '<path d="M2 4h12M2 8h12M2 12h12M5 2v4m6 0v4m-5 0v4"/>',
  expand: '<path d="M6 2H2v4m8-4h4v4M2 10v4h4m8-4v4h-4"/>',
  close: '<path d="m4 4 8 8m0-8-8 8"/>',
  clock: '<circle cx="8" cy="8" r="6"/><path d="M8 4v4l3 2"/>',
  eye: '<path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5Z"/><circle cx="8" cy="8" r="2"/>',
  info: '<circle cx="8" cy="8" r="6"/><path d="M8 7v5M8 4v1"/>',
  edit: '<path d="M11 2.5 13.5 5 6 12.5 2.5 13.5 3.5 10zM9.5 4l2.5 2.5"/>',
  warning: '<path d="M8 2.5 14.5 13.5h-13zM8 6.5v3.5m0 1.8v.2"/>',
  trash: '<path d="M2.5 4h11M6 4V2.5h4V4m-6.5 0 .7 9.5h6.6l.7-9.5M6.5 6.5V11m3-4.5V11"/>',
} as const;
export type Icon = keyof typeof paths;
export function icon(name: Icon): string {
  return `<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name]}</svg>`;
}

// Turnleaf's mark (the serif T with a turned corner) for the project header; see media/brand/turnleaf-icon.svg.
export const brandMark = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" class="brand-mark" width="18" height="18" aria-hidden="true" focusable="false"><rect width="256" height="256" rx="56.3" fill="#12355B"/><defs><mask id="turnleaf-mark" maskUnits="userSpaceOnUse" x="-200" y="-400" width="1400" height="1600"><rect x="-200" y="-400" width="1400" height="1600" fill="#fff"/><path d="M535,775 L865,775 L865,300 L535,300 L535,490 L815,490 Z" fill="#000"/></mask></defs><g transform="translate(51.01,199.68) scale(0.18618,-0.18618)"><path d="M805 770 815 550H772Q768 616 748.5 652.5Q729 689 693.5 703.5Q658 718 604 718Q553 718 527.0 715.5Q501 713 493.0 706.0Q485 699 485 687V163Q485 120 494.0 93.5Q503 67 532.0 54.5Q561 42 620 40V0H201V40Q261 42 290.0 54.5Q319 67 328.5 93.5Q338 120 338 163V687Q338 699 331.0 706.0Q324 713 302.0 715.5Q280 718 235 718Q199 718 166.0 714.0Q133 710 108.0 694.5Q83 679 68.0 645.0Q53 611 51 550H12L22 770Z" fill="#F3EFE6" mask="url(#turnleaf-mark)"/><path d="M535.0,770.0 L815.0,490.0 L535.0,490.0 Z" fill="#A9CBEA"/></g></svg>';
