function stroke(path: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`
}

export const IMAGE_ICONS = {
  zoomOut: stroke('<circle cx="7" cy="7" r="4.5"/><path d="M5 7h4M10.5 10.5l3 3"/>'),
  zoomIn: stroke('<circle cx="7" cy="7" r="4.5"/><path d="M5 7h4M7 5v4M10.5 10.5l3 3"/>'),
  fit: stroke('<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M5 6.5h6v3H5z"/>'),
  actualSize: stroke('<path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9"/>'),
  transparency: stroke(
    '<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path fill="currentColor" stroke="none" d="M2.5 2.5H8V8H2.5zM8 8h5.5v5.5H8z"/>',
  ),
}
