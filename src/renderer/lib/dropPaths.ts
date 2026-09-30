import { quoteArg } from '@shared/shellQuote'

export const PINE_PATH_MIME = 'application/x-pine-path'

export function acceptsPathDrop(types: readonly string[]): boolean {
  return types.includes(PINE_PATH_MIME) || types.includes('Files')
}

export function droppedPaths(transfer: DataTransfer): string[] {
  const own = transfer.getData(PINE_PATH_MIME)
  if (own) return [own]
  return [...transfer.files]
    .map((file) => window.pine.files.pathForFile(file))
    .filter((path) => path.length > 0)
}

export function pathsAsInput(paths: readonly string[]): string {
  return paths.length === 0 ? '' : `${paths.map(quoteArg).join(' ')} `
}
