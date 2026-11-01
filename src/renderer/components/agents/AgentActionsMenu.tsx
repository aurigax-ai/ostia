import { BookmarkSimpleIcon, BugIcon, GitForkIcon, HandshakeIcon } from '@phosphor-icons/react'
import type { JSX } from 'react'
import { Hint } from '@/components/common/Hint'
import { MenuItem } from '@/components/common/Menu'
import { SplitButtonMenu } from '@/components/common/SplitButton'
import { forkableResume, forkConversation } from '@/lib/agents/forkConversation'
import { useDict } from '@/lib/app/useDict'
import { askForHandoff, canHandOff } from '@/lib/handoff/handoffMenu'
import type { PaneNode } from '@/lib/layout/types'
import { parkRefusalOf, requestPark } from '@/lib/park/parkTab'
import { useAttentionStore } from '@/stores/agents/attentionStore'
import { useIncidentReportStore } from '@/stores/agents/incidentReportStore'
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
      <ParkItem workspaceId={workspaceId} paneId={pane.id} />
      <MenuItem icon={BugIcon} onClick={() => useIncidentReportStore.getState().open(pane.id)}>
        {d.privacy.incidents.menu}
      </MenuItem>
    </SplitButtonMenu>
  )
}

function ParkItem({ workspaceId, paneId }: { workspaceId: string; paneId: string }): JSX.Element {
  const d = useDict()
  const refusal = parkRefusalOf(workspaceId, paneId)
  const item = (
    <MenuItem
      icon={BookmarkSimpleIcon}
      disabled={refusal !== null}
      className="data-disabled:pointer-events-auto"
      onClick={() => void requestPark(workspaceId, paneId)}
    >
      {d.pane.parkTab}
    </MenuItem>
  )
  if (!refusal) return item
  return (
    <Hint label={d.pane.parkReasons[refusal]} side="left">
      {item}
    </Hint>
  )
}
