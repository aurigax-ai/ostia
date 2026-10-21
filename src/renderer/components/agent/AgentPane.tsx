import { useEffect, useRef } from 'react'
import { useDict } from '@/lib/app/useDict'
import { useSurfaceFocus } from '@/lib/panes/paneFocus'
import { ensureAgentSession, useAgentStore } from '@/stores/agent/agentStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { AgentView } from './AgentView'

export function AgentPane({
  workspaceId,
  paneId,
  sessionId,
}: {
  workspaceId: string
  paneId: string
  sessionId?: string
}): JSX.Element {
  const d = useDict()
  const composerRef = useRef<HTMLElement | null>(null)
  useSurfaceFocus(paneId, () => composerRef.current)
  const current = useAgentStore((s) => s.current[workspaceId])
  useEffect(() => {
    void ensureAgentSession(workspaceId, sessionId)
  }, [workspaceId, sessionId])
  useEffect(() => {
    if (current) {
      useLayoutStore.getState().setAgentSession(workspaceId, paneId, current, d.agentPane.paneTitle)
    }
  }, [workspaceId, paneId, current, d.agentPane.paneTitle])
  return (
    <div className="chat-pane flex h-full min-h-0 flex-col" data-pane-id={paneId}>
      {current ? (
        <AgentView
          key={current}
          workspaceId={workspaceId}
          sessionId={current}
          focusRef={composerRef}
        />
      ) : null}
    </div>
  )
}
