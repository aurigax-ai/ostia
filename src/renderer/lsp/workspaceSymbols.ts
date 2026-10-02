import type { SymbolInformation, WorkspaceSymbol } from 'vscode-languageserver-protocol'
import { monaco } from '../monaco/setup'

export const WORKSPACE_SYMBOL_LIMIT = 200
const NAME_MAX = 200

export interface WorkspaceSymbolHit {
  id: string
  name: string
  kind: number
  container: string
  path: string
  line: number
  column: number
  serverKey: string
}

export function toWorkspaceSymbolHits(
  serverKey: string,
  symbols: readonly (SymbolInformation | WorkspaceSymbol)[] | null | undefined,
): WorkspaceSymbolHit[] {
  const hits: WorkspaceSymbolHit[] = []
  for (const symbol of symbols ?? []) {
    const location = symbol?.location
    if (typeof symbol?.name !== 'string' || typeof location?.uri !== 'string') continue
    const uri = monaco.Uri.parse(location.uri)
    if (uri.scheme !== 'file') continue
    const start = 'range' in location ? location.range.start : null
    const line = start ? start.line + 1 : 1
    const column = start ? start.character + 1 : 1
    hits.push({
      id: [serverKey, uri.path, line, column, symbol.name, symbol.kind].join('\n'),
      name: symbol.name.slice(0, NAME_MAX),
      kind: symbol.kind,
      container: (symbol.containerName ?? '').slice(0, NAME_MAX),
      path: uri.path,
      line,
      column,
      serverKey,
    })
  }
  return hits
}

export function mergeWorkspaceSymbolHits(
  lists: readonly WorkspaceSymbolHit[][],
  limit = WORKSPACE_SYMBOL_LIMIT,
): WorkspaceSymbolHit[] {
  const seen = new Set<string>()
  const out: WorkspaceSymbolHit[] = []
  for (const list of lists) {
    for (const hit of list) {
      const place = [hit.path, hit.line, hit.column, hit.name].join('\n')
      if (seen.has(place)) continue
      seen.add(place)
      out.push(hit)
      if (out.length >= limit) return out
    }
  }
  return out
}
