import type { SearchNameHit } from '@shared/files/search'

export const FILE_SEARCH_DELAY_MS = 100

export type WorkspaceFileResult =
  | { status: 'hits'; root: string; hits: SearchNameHit[] }
  | { status: 'failed' }
  | { status: 'cancelled' }

export async function findWorkspaceFiles(
  root: string,
  text: string,
  includeIgnored: boolean,
): Promise<WorkspaceFileResult> {
  const outcome = await window.ostia.search.run({
    root,
    text,
    regex: false,
    caseSensitive: false,
    wholeWord: false,
    includeIgnored,
    namesOnly: true,
  })
  if (outcome.ok) return { status: 'hits', root: outcome.results.root, hits: outcome.results.names }
  return { status: outcome.error === 'cancelled' ? 'cancelled' : 'failed' }
}

export function splitFilePath(path: string): { name: string; dir: string } {
  const slash = path.lastIndexOf('/')
  return slash < 0
    ? { name: path, dir: '' }
    : { name: path.slice(slash + 1), dir: path.slice(0, slash) }
}
