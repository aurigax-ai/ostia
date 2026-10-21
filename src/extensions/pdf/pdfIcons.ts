function stroke(path: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`
}

export const PDF_ICONS = {
  sidebar: stroke('<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M6 2.5v11"/>'),
  zoomOut: stroke('<circle cx="7" cy="7" r="4.25"/><path d="m10.5 10.5 3 3M5 7h4"/>'),
  zoomIn: stroke('<circle cx="7" cy="7" r="4.25"/><path d="m10.5 10.5 3 3M5 7h4M7 5v4"/>'),
  fitWidth: stroke('<path d="M2 3v10M14 3v10M5 8h6M7 6 5 8l2 2M9 6l2 2-2 2"/>'),
  fitPage: stroke('<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>'),
  rotate: stroke('<path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3"/>'),
  crop: stroke('<path d="M4.5 1.5v9a1 1 0 0 0 1 1h9M1.5 4.5h9a1 1 0 0 1 1 1v9"/>'),
  search: stroke('<circle cx="7" cy="7" r="4.25"/><path d="m10.5 10.5 3 3"/>'),
}
