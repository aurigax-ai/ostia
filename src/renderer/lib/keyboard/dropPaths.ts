import { quoteArg } from '@shared/terminal/shellQuote'

export function acceptsPathDrop(types: readonly string[]): boolean {
  return types.includes('Files')
}

export function droppedPaths(transfer: DataTransfer): string[] {
  return [...transfer.files]
    .map((file) => window.ostia.files.pathForFile(file))
    .filter((path) => path.length > 0)
}

export function pathsAsInput(paths: readonly string[]): string {
  return paths.length === 0 ? '' : `${paths.map(quoteArg).join(' ')} `
}
