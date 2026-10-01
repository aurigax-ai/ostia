import { currentDict } from '../i18n/useDict'
import { findPane } from '../layout/tree'
import { useLayoutStore } from '../stores/layoutStore'
import { useSandboxStore } from '../stores/sandboxStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useWindowsStore } from '../stores/windowsStore'
import { type Workspace, useWorkspacesStore } from '../stores/workspacesStore'

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
  const dir = opts.dir ?? newWorkspaceDir(inheritFolder, defaultFolder, focusedPaneCwd())
  if (useWindowsStore.getState().detached) {
    window.pine.windows.newWorkspace({ dir, ...(opts.name ? { name: opts.name } : {}) })
    return null
  }
  const store = useWorkspacesStore.getState()
  store.addWorkspace(dir, placement)
  const created = useWorkspacesStore.getState().activeWorkspaceId
  const name = opts.name?.trim()
  if (created && name) store.rename(created, name)
  return created
}

export function scratchName(base: string, workspaces: readonly Workspace[]): string {
  const taken = new Set(workspaces.map((w) => w.customName ?? w.name))
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base} ${n}`)) n += 1
  return `${base} ${n}`
}

export interface ScratchWorkspaceOptions {
  sandboxed?: boolean
}

export async function startScratchWorkspace(
  opts: ScratchWorkspaceOptions = {},
): Promise<string | null> {
  const sandboxed = opts.sandboxed === true
  if (useWindowsStore.getState().detached) {
    window.pine.windows.newWorkspace({ scratch: true, sandboxed })
    return null
  }
  const dir = await window.pine.scratch.create()
  if (!dir) return null
  const { placement } = useSettingsStore.getState().workspaces
  const store = useWorkspacesStore.getState()
  const name = scratchName(currentDict().scratch.name, store.workspaces)
  store.addWorkspace(dir, placement, 'scratch')
  const created = useWorkspacesStore.getState().activeWorkspaceId
  if (!created) return null
  store.rename(created, name)
  if (sandboxed) await useSandboxStore.getState().setEnabled(created, true)
  return created
}
