import { paneIds } from '../layout/tree'
import { useLayoutStore } from '../stores/layoutStore'
import { useWorkspacesStore } from '../stores/workspacesStore'

export function scratchPaneIds(): Set<string> {
  const ids = new Set<string>()
  const byWorkspace = useLayoutStore.getState().byWorkspace
  for (const workspace of useWorkspacesStore.getState().workspaces) {
    const layout = workspace.kind === 'scratch' ? byWorkspace[workspace.id] : undefined
    if (layout) for (const id of paneIds(layout.root)) ids.add(id)
  }
  return ids
}
