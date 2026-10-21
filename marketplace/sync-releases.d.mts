export function placement(current: string | null, incoming: string): 'newest' | 'history'

export function historyFolders(root: string): string[]

export function syncRelease(
  root: string,
  archive: string,
  sourceDir: string,
): { id: string; version: string; newest: boolean } | null

export function writeHistory(root: string): void
