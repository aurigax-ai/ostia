import { IconButton } from '@/components/common/IconButton'
import { useDict } from '@/i18n/useDict'
import type { PaneNode } from '@/layout/types'
import { forkConversation, forkableResume } from '@/lib/agents/forkConversation'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { GitForkIcon } from '@phosphor-icons/react'

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
