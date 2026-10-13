import { quoteArg } from '@shared/terminal/shellQuote'

export const OSTIA_PATH_MIME = 'application/x-ostia-path'

export function acceptsPathDrop(types: readonly string[]): boolean {
  return types.includes(OSTIA_PATH_MIME) || types.includes('Files')
}

export function droppedPaths(transfer: DataTransfer): string[] {
  const own = transfer.getData(OSTIA_PATH_MIME)
  if (own) return [own]
  return [...transfer.files]
    .map((file) => window.ostia.files.pathForFile(file))
    .filter((path) => path.length > 0)
}

export function pathsAsInput(paths: readonly string[]): string {
  return paths.length === 0 ? '' : `${paths.map(quoteArg).join(' ')} `
}
