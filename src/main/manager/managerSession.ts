import type { StreamEvent } from '../../shared/agents/agentStream'
import type { AgentSessions } from '../agent/agentSessions'
import type { PortalPromptResult } from '../agent/portalPrompts'
import type { ManagerService } from './manager'

export interface SessionSink {
  events: (events: StreamEvent[]) => void
  waiting: (waiting: boolean) => void
  ended: () => void
}

export interface SessionHandle {
  prompt: (text: string) => Promise<PortalPromptResult>
  detach: () => void
}

export interface ManagerSessionDeps {
  sessions: () => AgentSessions | null
  manager: () => Pick<ManagerService, 'onEnd'> | null
}

export function createSessionAttacher({ sessions, manager }: ManagerSessionDeps) {
  return (paneId: string, sink: SessionSink): SessionHandle | null => {
    const host = sessions()
    const sessionId = host?.sessionOfPane(paneId)
    const stream = sessionId ? host?.stream(sessionId) : undefined
    const service = manager()
    if (!host || !sessionId || !stream || !service) return null
    const stops = [
      stream.subscribe(sink.events),
      host.watchWaiting(sessionId, sink.waiting),
      service.onEnd((ended) => {
        if (ended === paneId) sink.ended()
      }),
    ]
    return {
      prompt: (text) => host.promptFromPortal(sessionId, text),
      detach: () => {
        for (const stop of stops) stop()
      },
    }
  }
}
