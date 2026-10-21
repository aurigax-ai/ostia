import { GitForkIcon } from '@phosphor-icons/react'
import { IconButton } from '@/components/common/IconButton'
import { forkableResume, forkConversation } from '@/lib/agents/forkConversation'
import { useDict } from '@/lib/app/useDict'
import type { PaneNode } from '@/lib/layout/types'
import { useBlocksStore } from '@/stores/terminal/blocksStore'

export function AgentForkButton({
  pane,
  workspaceId,
}: {
  pane: PaneNode
  workspaceId: string
}): JSX.Element | null {
  const d = useDict()
  useBlocksStore((s) => s.running[pane.id])
  useBlocksStore((s) => s.byPane[pane.id])
  useBlocksStore((s) => s.agentBlocks[pane.id])
  if (!forkableResume(pane)) return null
  return (
    <IconButton
      icon={GitForkIcon}
      label={d.pane.forkConversation}
      onClick={() => forkConversation(workspaceId, pane.id)}
    />
  )
}
