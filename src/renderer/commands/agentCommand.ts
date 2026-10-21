import { openAgentPane } from '@/lib/agent/agentPane'
import { findPane } from '@/lib/layout/tree'
import { agentChatFor, startNewAgentSession } from '@/stores/agent/agentStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { registerCore } from './coreCommand'

function agentSessionOf(workspaceId: string | null, paneId: string | null): string | null {
  const root = workspaceId ? useLayoutStore.getState().byWorkspace[workspaceId]?.root : null
  const pane = root && paneId ? findPane(root, paneId) : null
  return pane?.kind === 'agent' ? (pane.agentSessionId ?? null) : null
}

function activeAgentSession(): string | null {
  const workspaceId = useWorkspacesStore.getState().activeWorkspaceId
  const layout = workspaceId ? useLayoutStore.getState().byWorkspace[workspaceId] : undefined
  return agentSessionOf(workspaceId, layout?.activePaneId ?? null)
}

export function registerAgentCommand(): void {
  registerCore({
    id: 'agent.open',
    category: 'agent',
    target: 'none',
    run: () => {
      openAgentPane()
    },
  })

  registerCore<{ paneId?: string } | undefined>({
    id: 'agent.newSession',
    category: 'agent',
    local: true,
    listed: () => activeAgentSession() !== null,
    run: async (args, ctx) => {
      const workspaceId = ctx.activeWorkspaceId
      const sessionId = agentSessionOf(workspaceId, args?.paneId ?? ctx.activePaneId)
      if (!workspaceId || !sessionId) return
      const status = agentChatFor(sessionId).status
      if (status === 'submitted' || status === 'streaming') return
      await startNewAgentSession(workspaceId)
    },
  })
}
