import { allPanes, findPane } from '../layout/tree'
import type { PaneNode } from '../layout/types'
import { type CommandBlock, useBlocksStore } from '../stores/blocksStore'
import {
  type CloseConfirmKind,
  type RunningGroup,
  useCloseConfirmStore,
} from '../stores/closeConfirmStore'
import { useEditorStatus } from '../stores/editorStatusStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useSettingsStore } from '../stores/settingsStore'
import { type Workspace, useWorkspacesStore } from '../stores/workspacesStore'

export function runningCommandsOf(
  panes: readonly string[],
  running: Readonly<Record<string, string | undefined>>,
  blocksByPane: Readonly<Record<string, CommandBlock[] | undefined>>,
): string[] {
  const commands: string[] = []
  for (const paneId of panes) {
    const blockId = running[paneId]
    if (blockId === undefined) continue
    commands.push(blocksByPane[paneId]?.find((b) => b.id === blockId)?.command.trim() ?? '')
  }
  return commands
}

export function unsavedFilesOf(
  panes: readonly PaneNode[],
  dirty: Readonly<Record<string, boolean>>,
): string[] {
  const files = new Set<string>()
  for (const pane of panes) {
    if (pane.kind === 'editor' && pane.filePath && dirty[pane.filePath]) files.add(pane.filePath)
  }
  return [...files]
}

function groupOf(workspace: Workspace, panes: readonly PaneNode[]): RunningGroup | null {
  const { running, byPane } = useBlocksStore.getState()
  const commands = runningCommandsOf(
    panes.map((p) => p.id),
    running,
    byPane,
  )
  const files = unsavedFilesOf(panes, useEditorStatus.getState().dirty)
  if (commands.length === 0 && files.length === 0) return null
  return {
    workspaceId: workspace.id,
    workspace: workspace.customName ?? workspace.name,
    commands,
    files,
  }
}

function runningGroup(workspace: Workspace): RunningGroup | null {
  if (workspace.kind === 'manager') {
    const name = workspace.customName ?? workspace.name
    return { workspaceId: workspace.id, workspace: name, commands: [name], files: [] }
  }
  const layout = useLayoutStore.getState().byWorkspace[workspace.id]
  return layout ? groupOf(workspace, allPanes(layout.root)) : null
}

function runningGroups(workspaces: readonly Workspace[]): RunningGroup[] {
  const groups: RunningGroup[] = []
  for (const workspace of workspaces) {
    const group = runningGroup(workspace)
    if (group) groups.push(group)
  }
  return groups
}

async function confirmGroups(kind: CloseConfirmKind, groups: RunningGroup[]): Promise<boolean> {
  if (groups.length === 0) return true
  return useCloseConfirmStore.getState().ask(kind, groups)
}

function groupsToConfirm(workspaces: readonly Workspace[], enabled: boolean): RunningGroup[] {
  return enabled ? runningGroups(workspaces) : []
}

export async function requestCloseWorkspace(id: string): Promise<void> {
  const workspace = useWorkspacesStore.getState().workspaces.find((w) => w.id === id)
  if (!workspace) return
  const { confirmClose } = useSettingsStore.getState().workspaces
  if (await confirmGroups('workspace', groupsToConfirm([workspace], confirmClose))) {
    useWorkspacesStore.getState().closeWorkspace(id)
  }
}

export async function requestCloseOthers(id: string): Promise<void> {
  const others = useWorkspacesStore.getState().workspaces.filter((w) => w.id !== id)
  const { confirmClose } = useSettingsStore.getState().workspaces
  if (await confirmGroups('workspace', groupsToConfirm(others, confirmClose))) {
    useWorkspacesStore.getState().closeOthers(id)
  }
}

function isManagerPane(workspaceId: string, paneId: string): boolean {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId]
  return layout ? findPane(layout.root, paneId)?.kind === 'manager' : false
}

function paneGroup(workspace: Workspace, paneId: string): RunningGroup | null {
  if (isManagerPane(workspace.id, paneId)) return runningGroup(workspace)
  const layout = useLayoutStore.getState().byWorkspace[workspace.id]
  const pane = layout ? findPane(layout.root, paneId) : null
  return pane ? groupOf(workspace, [pane]) : null
}

export async function requestClosePane(workspaceId: string, paneId: string): Promise<void> {
  const workspace = useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId)
  const { confirmClose } = useSettingsStore.getState().workspaces
  const group = workspace && confirmClose ? paneGroup(workspace, paneId) : null
  if (await confirmGroups('pane', group ? [group] : [])) {
    useLayoutStore.getState().closePane(workspaceId, paneId)
  }
}

export function quitGroups(): RunningGroup[] {
  const { confirmQuit: enabled } = useSettingsStore.getState().workspaces
  return groupsToConfirm(useWorkspacesStore.getState().workspaces, enabled)
}

export function confirmQuit(groups: RunningGroup[]): Promise<boolean> {
  return confirmGroups('quit', groups)
}

export function confirmMove(workspace: Workspace, panes: readonly PaneNode[]): Promise<boolean> {
  const files = unsavedFilesOf(panes, useEditorStatus.getState().dirty)
  if (files.length === 0) return Promise.resolve(true)
  return confirmGroups('move', [
    {
      workspaceId: workspace.id,
      workspace: workspace.customName ?? workspace.name,
      commands: [],
      files,
    },
  ])
}
