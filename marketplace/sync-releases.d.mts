export function parseExtensionTag(tag: string): { id: string; version: string } | null

export function placement(current: string | null, incoming: string): 'newest' | 'history'

export function historyFolders(root: string): string[]

export function unseen(root: string, tags: string[]): { tag: string; id: string; version: string }[]

export function signatureProblem(
  dir: string,
  id: string,
  version: string,
  publicKey: string,
): string | null

export function syncRelease(
  root: string,
  archive: string,
  sourceDir: string,
  expected: { id: string; version: string },
  publicKey: string,
): { id: string; version: string; newest: boolean } | null

export function writeHistory(root: string): void
