import type { SearchNameHit, SearchRequest } from '@shared/files/search'

export const FILE_SEARCH_DELAY_MS = 100
export const LINE_SEARCH_DELAY_MS = 200

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

export interface FilePosition {
  name: string
  line?: number
  column?: number
}

export function splitFilePosition(text: string): FilePosition {
  const found = /^(.*?[^:\s]):(\d+)(?::(\d+))?:?$/.exec(text.trim())
  if (!found) return { name: text }
  const line = Number(found[2])
  if (line < 1) return { name: text }
  const column = found[3] ? Number(found[3]) : undefined
  return { name: found[1], line, ...(column && column > 0 ? { column } : {}) }
}

interface WorkspaceLine {
  path: string
  line: number
  column: number
  text: string
}

export type WorkspaceLineResult =
  | { status: 'hits'; root: string; lines: WorkspaceLine[]; more: boolean }
  | { status: 'failed' }
  | { status: 'cancelled' }

export async function findWorkspaceLines(
  root: string,
  text: string,
  includeIgnored: boolean,
): Promise<WorkspaceLineResult> {
  const request: SearchRequest = {
    root,
    text,
    regex: false,
    caseSensitive: false,
    wholeWord: false,
    includeIgnored,
    linesOnly: true,
  }
  const outcome = await window.ostia.search.run(request)
  if (!outcome.ok) return { status: outcome.error === 'cancelled' ? 'cancelled' : 'failed' }
  const lines = outcome.results.files.flatMap((file) =>
    file.matches.map((match) => ({
      path: file.path,
      line: match.line,
      column: match.column,
      text: match.text.trim(),
    })),
  )
  return { status: 'hits', root: outcome.results.root, lines, more: outcome.results.truncated }
}
