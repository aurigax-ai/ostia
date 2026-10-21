export type FileViewKind = 'text' | 'pdf'

function extension(path: string | undefined): string {
  const match = path ? /\.([A-Za-z0-9]+)$/.exec(path) : null
  return match ? match[1].toLowerCase() : ''
}

export function fileViewKind(path: string | undefined): FileViewKind {
  return extension(path) === 'pdf' ? 'pdf' : 'text'
}
