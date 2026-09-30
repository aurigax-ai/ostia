import { findPane } from '../layout/tree'
import { useLayoutStore } from '../stores/layoutStore'
import { useWorkspacesStore } from '../stores/workspacesStore'

export function focusedDirs(): Map<string, string> {
  const dirs = new Map<string, string>()
  const layouts = useLayoutStore.getState().byWorkspace
  for (const workspace of useWorkspacesStore.getState().workspaces) {
    const layout = layouts[workspace.id]
    const cwd = layout ? findPane(layout.root, layout.activePaneId)?.cwd : undefined
    if (cwd?.startsWith('/')) dirs.set(workspace.id, cwd)
  }
  return dirs
}

export function startWorkspaceProjects(): () => void {
  const asked = new Map<string, string>()
  const sync = (): void => {
    for (const [workspaceId, dir] of focusedDirs()) {
      if (asked.get(workspaceId) === dir) continue
      asked.set(workspaceId, dir)
      void window.pine.openPath.project(dir).then((project) => {
        if (!project || asked.get(workspaceId) !== dir) return
        useWorkspacesStore.getState().setProject(workspaceId, project)
      })
    }
  }
  sync()
  const unsubscribe = [useLayoutStore.subscribe(sync), useWorkspacesStore.subscribe(sync)]
  return () => {
    for (const off of unsubscribe) off()
  }
}
