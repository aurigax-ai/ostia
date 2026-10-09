import { findPane, paneIds } from '@/layout/tree'
import { useSandboxStore } from '@/stores/app/sandboxStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'

export function scratchPaneIds(): Set<string> {
  const ids = new Set<string>()
  const byWorkspace = useLayoutStore.getState().byWorkspace
  for (const workspace of useWorkspacesStore.getState().workspaces) {
    const layout = workspace.kind === 'scratch' ? byWorkspace[workspace.id] : undefined
    if (layout) for (const id of paneIds(layout.root)) ids.add(id)
  }
  return ids
}

export function historyHiddenFrom(paneId: string): Set<string> {
  const ids = scratchPaneIds()
  const { byWorkspace } = useLayoutStore.getState()
  const own = Object.keys(byWorkspace).find((id) => findPane(byWorkspace[id].root, paneId))
  if (!own || !useSandboxStore.getState().enabled[own]) return ids
  for (const [workspaceId, layout] of Object.entries(byWorkspace)) {
    if (workspaceId !== own) for (const id of paneIds(layout.root)) ids.add(id)
  }
  return ids
}
