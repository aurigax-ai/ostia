import { BookmarkSimpleIcon, GitForkIcon, HandshakeIcon } from '@phosphor-icons/react'
import { MenuItem } from '@/components/common/Menu'
import { SplitButtonMenu } from '@/components/common/SplitButton'
import { forkableResume, forkConversation } from '@/lib/agents/forkConversation'
import { useDict } from '@/lib/app/useDict'
import { askForHandoff, canHandOff } from '@/lib/handoff/handoffMenu'
import type { PaneNode } from '@/lib/layout/types'
import { parkRefusalOf, requestPark } from '@/lib/park/parkTab'
import { useAttentionStore } from '@/stores/agents/attentionStore'
import { useSandboxStore } from '@/stores/app/sandboxStore'
import { useBlocksStore } from '@/stores/terminal/blocksStore'

export function AgentActionsMenu({
  pane,
  workspaceId,
}: {
  pane: PaneNode
  workspaceId: string
}): JSX.Element {
  const d = useDict()
  useBlocksStore((s) => s.running[pane.id])
  useBlocksStore((s) => s.byPane[pane.id])
  useBlocksStore((s) => s.agentBlocks[pane.id])
  useAttentionStore((s) => s.byPane[pane.id]?.state)
  useSandboxStore((s) => s.enabled[workspaceId])
  const refusal = parkRefusalOf(workspaceId, pane.id)
  return (
    <SplitButtonMenu label={d.pane.agentActions} size="2xs" variant="ghost">
      {forkableResume(pane) ? (
        <MenuItem icon={GitForkIcon} onClick={() => forkConversation(workspaceId, pane.id)}>
          {d.pane.forkAction}
        </MenuItem>
      ) : null}
      {canHandOff(pane, workspaceId) ? (
        <MenuItem icon={HandshakeIcon} onClick={askForHandoff}>
          {d.pane.handoffAction}
        </MenuItem>
      ) : null}
      <MenuItem
        icon={BookmarkSimpleIcon}
        disabled={refusal !== null}
        hint={refusal ? d.pane.parkReasons[refusal] : null}
        onClick={() => void requestPark(workspaceId, pane.id)}
      >
        {d.pane.parkTab}
      </MenuItem>
    </SplitButtonMenu>
  )
}
