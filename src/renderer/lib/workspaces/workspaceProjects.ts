import { findPane } from '@/layout/tree'
import { useLayoutStore } from '@/stores/layoutStore'
import { useSandboxStore } from '@/stores/sandboxStore'
import { type Workspace, useWorkspacesStore } from '@/stores/workspacesStore'

export function isAnchored(workspace: Pick<Workspace, 'anchored'>): boolean {
  return workspace.anchored === true
}

export function focusedDir(workspaceId: string): string | null {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId]
  const cwd = layout ? findPane(layout.root, layout.activePaneId)?.cwd : undefined
  return cwd?.startsWith('/') ? cwd : null
}

export function canMoveWorkspace(workspaceId: string): boolean {
  const workspace = useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId)
  if (!workspace || workspace.kind === 'scratch' || workspace.kind === 'manager') return false
  return !useSandboxStore.getState().enabled[workspaceId]
}

export async function moveWorkspaceTo(workspaceId: string, dir: string): Promise<boolean> {
  if (!canMoveWorkspace(workspaceId)) return false
  const project = await window.ostia.openPath.project(dir, true)
  if (!project) return false
  useWorkspacesStore.getState().setProject(workspaceId, project, true)
  return true
}

export async function anchorToFocusedPane(workspaceId: string): Promise<boolean> {
  const dir = focusedDir(workspaceId)
  return dir ? moveWorkspaceTo(workspaceId, dir) : false
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
      void window.ostia.openPath.project(dir).then((project) => {
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
