import { PI_MANAGER_AGENT } from '@shared/agents/managerSettings'
import { useRef } from 'react'
import { useSurfaceFocus } from '@/lib/panes/paneFocus'
import { useAgentStore } from '@/stores/agent/agentStore'
import { AgentView } from './AgentView'

export function ManagerAgentPane({
  workspaceId,
  paneId,
}: {
  workspaceId: string
  paneId: string
}): JSX.Element {
  const composerRef = useRef<HTMLElement | null>(null)
  useSurfaceFocus(paneId, () => composerRef.current)
  const current = useAgentStore((s) => s.current[workspaceId])
  return (
    <div
      className="chat-pane manager-agent flex h-full min-h-0 flex-col bg-bg"
      data-pane-id={paneId}
    >
      <div className="manager-agent-title">{PI_MANAGER_AGENT}</div>
      {current ? (
        <AgentView
          key={current}
          workspaceId={workspaceId}
          sessionId={current}
          focusRef={composerRef}
          manager
        />
      ) : null}
    </div>
  )
}
