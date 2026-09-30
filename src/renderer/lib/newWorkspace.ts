import { findPane } from '../layout/tree'
import { useLayoutStore } from '../stores/layoutStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useWindowsStore } from '../stores/windowsStore'
import { useWorkspacesStore } from '../stores/workspacesStore'

export function newWorkspaceDir(
  inheritFolder: boolean,
  defaultFolder: string,
  focusedCwd: string | undefined,
): string {
  return inheritFolder && focusedCwd ? focusedCwd : defaultFolder
}

function focusedPaneCwd(): string | undefined {
  const workspaceId = useWorkspacesStore.getState().activeWorkspaceId
  const layout = workspaceId ? useLayoutStore.getState().byWorkspace[workspaceId] : undefined
  if (!layout?.activePaneId) return undefined
  return findPane(layout.root, layout.activePaneId)?.cwd
}

export interface NewWorkspaceOptions {
  dir?: string
  name?: string
}

export function startNewWorkspace(opts: NewWorkspaceOptions = {}): void {
  const { placement, inheritFolder, defaultFolder } = useSettingsStore.getState().workspaces
  const dir = opts.dir ?? newWorkspaceDir(inheritFolder, defaultFolder, focusedPaneCwd())
  if (useWindowsStore.getState().detached) {
    window.pine.windows.newWorkspace({ dir, ...(opts.name ? { name: opts.name } : {}) })
    return
  }
  const store = useWorkspacesStore.getState()
  store.addWorkspace(dir, placement)
  const created = useWorkspacesStore.getState().activeWorkspaceId
  const name = opts.name?.trim()
  if (created && name) store.rename(created, name)
}
