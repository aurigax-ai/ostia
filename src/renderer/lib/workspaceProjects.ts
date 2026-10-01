import { findPane } from '../layout/tree'
import { useLayoutStore } from '../stores/layoutStore'
import { type Workspace, useWorkspacesStore } from '../stores/workspacesStore'

const HOME_PROJECT = '~'

export function isAnchored(workspace: Pick<Workspace, 'projectDir'>): boolean {
  return workspace.projectDir !== undefined && workspace.projectDir !== HOME_PROJECT
}

export function focusedDir(workspaceId: string): string | null {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId]
  const cwd = layout ? findPane(layout.root, layout.activePaneId)?.cwd : undefined
  return cwd?.startsWith('/') ? cwd : null
}

export async function anchorToFocusedPane(workspaceId: string): Promise<boolean> {
  const dir = focusedDir(workspaceId)
  const project = dir ? await window.pine.openPath.project(dir) : null
  if (!project) return false
  useWorkspacesStore.getState().setProject(workspaceId, project)
  return true
}

export function focusedDirs(): Map<string, string> {
  const dirs = new Map<string, string>()
  const layouts = useLayoutStore.getState().byWorkspace
  for (const workspace of useWorkspacesStore.getState().workspaces) {
    if (isAnchored(workspace)) continue
    const layout = layouts[workspace.id]
    const cwd = layout ? findPane(layout.root, layout.activePaneId)?.cwd : undefined
    const dir = cwd ?? (workspace.projectDir ? undefined : workspace.workDir)
    if (dir?.startsWith('/')) dirs.set(workspace.id, dir)
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
