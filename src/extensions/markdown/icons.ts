function stroke(path: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`
}

export const ICONS = {
  contents: stroke('<path d="M6 4h8M6 8h8M6 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01"/>'),
  search: stroke('<circle cx="7" cy="7" r="4.25"/><path d="m10.5 10.5 3 3"/>'),
  source: stroke('<path d="m5.5 4.5-3.5 3.5 3.5 3.5M10.5 4.5 14 8l-3.5 3.5"/>'),
}
