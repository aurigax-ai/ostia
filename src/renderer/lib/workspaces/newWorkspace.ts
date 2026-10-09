import { findPane } from '@/layout/tree'
import { useLayoutStore } from '@/stores/layoutStore'
import { useSandboxStore } from '@/stores/sandboxStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useWindowsStore } from '@/stores/windowsStore'
import { nameFromWorkDir, nextWorkspaceId, useWorkspacesStore } from '@/stores/workspacesStore'
import { codeName } from './codeName'

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

export function openNewWindow(): Promise<boolean> {
  const { inheritFolder, defaultFolder } = useSettingsStore.getState().workspaces
  const workDir = newWorkspaceDir(inheritFolder, defaultFolder, focusedPaneCwd())
  return window.ostia.windows.openWith([
    { id: nextWorkspaceId(), name: nameFromWorkDir(workDir), kind: 'terminal', workDir },
  ])
}

export interface NewWorkspaceOptions {
  dir?: string
  name?: string
  focus?: boolean
}

export function startNewWorkspace(opts: NewWorkspaceOptions = {}): string | null {
  const { placement, inheritFolder, defaultFolder } = useSettingsStore.getState().workspaces
  const dir = opts.dir ?? newWorkspaceDir(inheritFolder, defaultFolder, focusedPaneCwd())
  if (useWindowsStore.getState().detached) {
    window.ostia.windows.newWorkspace({ dir, ...(opts.name ? { name: opts.name } : {}) })
    return null
  }
  const store = useWorkspacesStore.getState()
  const before = store.activeWorkspaceId
  store.addWorkspace(dir, placement)
  const created = useWorkspacesStore.getState().activeWorkspaceId
  const name = opts.name?.trim()
  if (created && name) store.rename(created, name)
  if (opts.focus === false && before && created !== before)
    useWorkspacesStore.setState({ activeWorkspaceId: before })
  return created
}

export interface ScratchWorkspaceOptions {
  sandboxed?: boolean
}

export async function startScratchWorkspace(
  opts: ScratchWorkspaceOptions = {},
): Promise<string | null> {
  const sandboxed = opts.sandboxed === true
  if (useWindowsStore.getState().detached) {
    window.ostia.windows.newWorkspace({ scratch: true, sandboxed })
    return null
  }
  const dir = await window.ostia.scratch.create()
  if (!dir) return null
  const { placement } = useSettingsStore.getState().workspaces
  const store = useWorkspacesStore.getState()
  const name = codeName(new Set(store.workspaces.map((w) => w.customName ?? w.name)))
  store.addWorkspace(dir, placement, 'scratch')
  const created = useWorkspacesStore.getState().activeWorkspaceId
  if (!created) return null
  store.rename(created, name)
  if (sandboxed) await useSandboxStore.getState().setEnabled(created, true)
  return created
}
