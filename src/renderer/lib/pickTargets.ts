import type { AttentionState } from '@shared/types'
import { allPanes } from '../layout/tree'
import type { LayoutNode } from '../layout/types'
import type { PaneAttention } from './attention'

export interface PickTarget {
  paneId: string
  workspaceId: string
  workspaceName: string
  title: string
  cwd?: string
  state: AttentionState
  sameWorkspace: boolean
}

export interface PickTargetInput {
  workspaces: readonly { id: string; name: string }[]
  layouts: Readonly<Record<string, { root: LayoutNode }>>
  sourceWorkspaceId: string
  attention: Readonly<Record<string, PaneAttention>>
  touchedAt: Readonly<Record<string, number>>
}

export function pickTargets(input: PickTargetInput): PickTarget[] {
  const out: PickTarget[] = []
  for (const workspace of input.workspaces) {
    const layout = input.layouts[workspace.id]
    if (!layout) continue
    for (const pane of allPanes(layout.root)) {
      if (pane.kind !== 'terminal' && pane.kind !== 'agent') continue
      out.push({
        paneId: pane.id,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        title: pane.title,
        cwd: pane.cwd,
        state: input.attention[pane.id]?.state ?? 'none',
        sameWorkspace: workspace.id === input.sourceWorkspaceId,
      })
    }
  }
  const recency = (id: string): number => input.touchedAt[id] ?? 0
  return out.sort((a, b) => {
    if (a.sameWorkspace !== b.sameWorkspace) return a.sameWorkspace ? -1 : 1
    return recency(b.paneId) - recency(a.paneId)
  })
}
