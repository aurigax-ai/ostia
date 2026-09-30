import type { ManagerOpenPaneRequest } from '@shared/types'
import { currentDict, fmt } from '../i18n/useDict'
import { useLayoutStore } from '../stores/layoutStore'
import { useWorkspacesStore } from '../stores/workspacesStore'

export function openManagerWorkspace(req: ManagerOpenPaneRequest): string | null {
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
  return useLayoutStore.getState().openManager(workspaceId, { cwd: req.cwd, title: req.agent })
}

export function wireManagerBridge(): void {
  window.pine?.manager?.onOpen(openManagerWorkspace)
}
