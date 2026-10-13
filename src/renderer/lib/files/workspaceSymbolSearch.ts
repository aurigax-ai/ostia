import { allPanes } from '@/layout/tree'
import type { WorkspaceSymbolHit } from '@/lsp/workspaceSymbols'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'

export const SYMBOL_SEARCH_DELAY_MS = 150

export interface WorkspaceSymbolResult {
  servers: number
  hits: WorkspaceSymbolHit[]
}

export async function findWorkspaceSymbols(
  workspaceId: string | null,
  query: string,
): Promise<WorkspaceSymbolResult> {
  const layout = workspaceId ? useLayoutStore.getState().byWorkspace[workspaceId] : undefined
  if (!layout?.root) return { servers: 0, hits: [] }
  const paneIds = new Set(allPanes(layout.root).map((pane) => pane.id))
  const { searchWorkspaceSymbols } = await import('@/lsp/client')
  return searchWorkspaceSymbols(paneIds, query)
}

export function symbolPlace(hit: WorkspaceSymbolHit, workDir: string | undefined): string {
  const base = workDir ? (workDir.endsWith('/') ? workDir : `${workDir}/`) : null
  const path = base && hit.path.startsWith(base) ? hit.path.slice(base.length) : hit.path
  return `${path}:${hit.line}`
}
