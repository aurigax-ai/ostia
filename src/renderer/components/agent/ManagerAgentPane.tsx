import { PI_MANAGER_AGENT } from '@shared/agents/managerSettings'
import { useRef } from 'react'
import { useDict } from '@/lib/app/useDict'
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
  const d = useDict()
  const composerRef = useRef<HTMLElement | null>(null)
  useSurfaceFocus(paneId, () => composerRef.current)
  const current = useAgentStore((s) => s.current[workspaceId])
  return (
    <div className="chat-pane manager-agent flex h-full min-h-0 flex-col" data-pane-id={paneId}>
      <div className="manager-agent-strip">
        <span>{d.manager.sessionLabel}</span>
        <span>{PI_MANAGER_AGENT}</span>
        <span />
      </div>
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
