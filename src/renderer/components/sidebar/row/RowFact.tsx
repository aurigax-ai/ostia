import type { JSX } from 'react'
import { allPanes } from '@/lib/layout/tree'
import { rowFact } from '@/lib/workspaces/rowSummary'
import { latestAttentionMessage, runningTitle } from '@/lib/workspaces/workspaceSummary'
import { useAttentionStore } from '@/stores/agents/attentionStore'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import type { Workspace } from '@/stores/workspaces/workspaceTypes'

export function RowFact({
  workspace: w,
  offline,
  showLive,
}: {
  workspace: Workspace
  offline: string | null
  showLive: boolean
}): JSX.Element | null {
  const layout = useLayoutStore((s) => s.byWorkspace[w.id])
  const panes = layout ? allPanes(layout.root) : []
  const message = useAttentionStore((s) => latestAttentionMessage(panes, s.byPane))
  const running = useBlocksStore((s) => runningTitle(panes, layout?.activePaneId, s.running))
  const fact = rowFact({
    state: w.state,
    message: showLive ? message : null,
    offline,
    running: showLive ? running : null,
  })
  if (!fact) return null
  return <span className={`tab-fact ${fact.tone}`}>{fact.text}</span>
}
