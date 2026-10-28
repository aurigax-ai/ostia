import type { ManagerOpenPaneRequest } from '@shared/agents/agentsApi'
import { currentDict, fmt } from '@/lib/app/useDict'
import { ensureAgentSession } from '@/stores/agent/agentStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'

export async function openManagerWorkspace(req: ManagerOpenPaneRequest): Promise<string | null> {
  const store = useWorkspacesStore.getState()
  for (const old of store.workspaces.filter((w) => w.kind === 'manager')) {
    store.closeWorkspace(old.id)
  }
  useWorkspacesStore.getState().addWorkspace(req.cwd, 'end', 'manager')
  const workspaceId = useWorkspacesStore.getState().activeWorkspaceId
  if (!workspaceId) return null
  useWorkspacesStore
    .getState()
    .rename(workspaceId, fmt(currentDict().manager.workspaceName, { agent: req.agent }))
  const paneId = useLayoutStore
    .getState()
    .openManager(workspaceId, { cwd: req.cwd, title: req.agent, session: req.session })
  if (paneId && req.session) await ensureAgentSession(workspaceId, paneId, undefined, 'manager')
  return paneId
}

export function wireManagerBridge(): void {
  window.ostia.manager.onOpen(openManagerWorkspace)
}
