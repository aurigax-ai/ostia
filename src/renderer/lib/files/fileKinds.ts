export type FileViewKind = 'text' | 'image' | 'pdf' | 'spreadsheet'

const SPREADSHEET_EXTENSIONS = new Set(['xlsx', 'xlsm', 'xlsb', 'xls', 'ods'])

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
}

export function extension(path: string | undefined): string {
  const match = path ? /\.([A-Za-z0-9]+)$/.exec(path) : null
  return match ? match[1].toLowerCase() : ''
}

export function imageMimeType(path: string | undefined): string | null {
  return IMAGE_TYPES[extension(path)] ?? null
}

export function fileViewKind(path: string | undefined): FileViewKind {
  if (imageMimeType(path)) return 'image'
  if (extension(path) === 'pdf') return 'pdf'
  if (SPREADSHEET_EXTENSIONS.has(extension(path))) return 'spreadsheet'
  return 'text'
}
