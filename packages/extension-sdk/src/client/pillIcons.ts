function stroke(path: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`
}

export const PILL_ICONS = {
  caretDown: stroke('<path d="m4 6 4 4 4-4"/>'),
  caretUp: stroke('<path d="m4 10 4-4 4 4"/>'),
  caretLeft: stroke('<path d="m10 4-4 4 4 4"/>'),
  caretRight: stroke('<path d="m6 4 4 4-4 4"/>'),
  check: stroke('<path d="m3.5 8.5 3 3 6-7"/>'),
  close: stroke('<path d="m4 4 8 8M12 4l-8 8"/>'),
  search: stroke('<circle cx="7" cy="7" r="4.25"/><path d="m10.5 10.5 3 3"/>'),
  highlight: stroke('<path d="m9.5 2.5 4 4-5.5 5.5-4-4zM6 10l-2.5 3.5H7M8 14h5.5"/>'),
}
