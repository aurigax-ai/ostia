export type FileViewKind = 'text' | 'image' | 'pdf'

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

function extension(path: string | undefined): string {
  const match = path ? /\.([A-Za-z0-9]+)$/.exec(path) : null
  return match ? match[1].toLowerCase() : ''
}

export function imageMimeType(path: string | undefined): string | null {
  return IMAGE_TYPES[extension(path)] ?? null
}

export function fileViewKind(path: string | undefined): FileViewKind {
  if (imageMimeType(path)) return 'image'
  if (extension(path) === 'pdf') return 'pdf'
  return 'text'
}
