function stroke(path: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`
}

export const MEDIA_ICONS = {
  play: stroke('<path d="M5 3.25v9.5L12.5 8z"/>'),
  pause: stroke('<path d="M5.5 3.5v9M10.5 3.5v9"/>'),
  back: stroke('<path d="M8 4v8L2.5 8zM13.5 4v8L8 8z"/>'),
  forward: stroke('<path d="M8 4v8l5.5-4zM2.5 4v8L8 8z"/>'),
  volume: stroke('<path d="M2.5 6v4h2.5L8.5 13V3L5 6z"/><path d="M11 5.5a3.5 3.5 0 0 1 0 5"/>'),
  muted: stroke('<path d="M2.5 6v4h2.5L8.5 13V3L5 6z"/><path d="m11 6 3 4m0-4-3 4"/>'),
  loop: stroke(
    '<path d="M3 7V6a2 2 0 0 1 2-2h7.5M10.5 2 13 4l-2.5 2M13 9v1a2 2 0 0 1-2 2H3.5M5.5 14 3 12l2.5-2"/>',
  ),
  caretDown: stroke('<path d="m4 6 4 4 4-4"/>'),
  check: stroke('<path d="m3.5 8.5 3 3 6-7"/>'),
  note: stroke(
    '<path d="M6 11.5V4l6-1.5V10"/><circle cx="4.5" cy="11.5" r="1.5"/><circle cx="10.5" cy="10" r="1.5"/>',
  ),
}
