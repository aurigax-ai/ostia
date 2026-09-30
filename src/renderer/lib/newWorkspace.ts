import { findPane } from '../layout/tree'
import { useLayoutStore } from '../stores/layoutStore'
import { useSettingsStore } from '../stores/settingsStore'
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

export function startNewWorkspace(opts: NewWorkspaceOptions = {}): string | null {
  const { placement, inheritFolder, defaultFolder } = useSettingsStore.getState().workspaces
  const store = useWorkspacesStore.getState()
  store.addWorkspace(
    opts.dir ?? newWorkspaceDir(inheritFolder, defaultFolder, focusedPaneCwd()),
    placement,
  )
  const created = useWorkspacesStore.getState().activeWorkspaceId
  const name = opts.name?.trim()
  if (created && name) store.rename(created, name)
  return created
}
