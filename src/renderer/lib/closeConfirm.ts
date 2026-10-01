import { allPanes, findPane } from '../layout/tree'
import type { PaneNode } from '../layout/types'
import { type CommandBlock, useBlocksStore } from '../stores/blocksStore'
import {
  type CloseConfirmKind,
  type RunningGroup,
  useCloseConfirmStore,
} from '../stores/closeConfirmStore'
import { type DiskProblem, useEditorStatus } from '../stores/editorStatusStore'
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
  disk: Readonly<Record<string, DiskProblem>> = {},
): string[] {
  const files = new Set<string>()
  for (const pane of panes) {
    if (pane.kind !== 'editor' || !pane.filePath) continue
    if (dirty[pane.filePath] || disk[pane.filePath] === 'deleted') files.add(pane.filePath)
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
  const files = unsavedFilesOf(
    panes,
    useEditorStatus.getState().dirty,
    useEditorStatus.getState().disk,
  )
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

function emptyGroup(workspace: Workspace): RunningGroup {
  return {
    workspaceId: workspace.id,
    workspace: workspace.customName ?? workspace.name,
    commands: [],
    files: [],
  }
}

export function withScratchGroups(
  workspaces: readonly Workspace[],
  groups: readonly RunningGroup[],
  scratchFiles: Readonly<Record<string, number>>,
): RunningGroup[] {
  const out: RunningGroup[] = []
  for (const workspace of workspaces) {
    const count = workspace.kind === 'scratch' ? (scratchFiles[workspace.id] ?? 0) : 0
    const group = groups.find((g) => g.workspaceId === workspace.id)
    if (count > 0) out.push({ ...(group ?? emptyGroup(workspace)), scratchFiles: count })
    else if (group) out.push(group)
  }
  return out
}

async function closeGroups(workspaces: readonly Workspace[]): Promise<RunningGroup[]> {
  const { confirmClose } = useSettingsStore.getState().workspaces
  const counts: Record<string, number> = {}
  for (const workspace of workspaces) {
    if (workspace.kind !== 'scratch') continue
    counts[workspace.id] = await window.pine.scratch.files(workspace.id).catch(() => 0)
  }
  return withScratchGroups(workspaces, groupsToConfirm(workspaces, confirmClose), counts)
}

export async function requestCloseWorkspace(id: string): Promise<void> {
  const workspace = useWorkspacesStore.getState().workspaces.find((w) => w.id === id)
  if (!workspace || useLayoutStore.getState().isLocked(id)) return
  if (await confirmGroups('workspace', await closeGroups([workspace]))) {
    useWorkspacesStore.getState().closeWorkspace(id)
  }
}

export async function requestCloseOthers(id: string): Promise<void> {
  const others = useWorkspacesStore
    .getState()
    .workspaces.filter((w) => w.id !== id && !useLayoutStore.getState().isLocked(w.id))
  if (await confirmGroups('workspace', await closeGroups(others))) {
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
  if (useLayoutStore.getState().isLocked(workspaceId, paneId)) return
  const workspace = useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId)
  const { confirmClose } = useSettingsStore.getState().workspaces
  const group = workspace && confirmClose ? paneGroup(workspace, paneId) : null
  if (await confirmGroups('pane', group ? [group] : [])) {
    useLayoutStore.getState().closePane(workspaceId, paneId)
  }
}

export async function closePaneForAgent(workspaceId: string, paneId: string): Promise<void> {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId]
  const pane = layout ? findPane(layout.root, paneId) : null
  const { dirty, disk } = useEditorStatus.getState()
  const asks = pane?.kind === 'manager' || (pane && unsavedFilesOf([pane], dirty, disk).length > 0)
  if (asks) await requestClosePane(workspaceId, paneId)
  else useLayoutStore.getState().closePane(workspaceId, paneId)
}

export function quitGroups(): RunningGroup[] {
  const { confirmQuit: enabled } = useSettingsStore.getState().workspaces
  const { workspaces } = useWorkspacesStore.getState()
  const groups = groupsToConfirm(workspaces, enabled)
  const scratch = workspaces.filter(
    (w) => w.kind === 'scratch' && !groups.some((g) => g.workspaceId === w.id),
  )
  return [...groups, ...scratch.map(emptyGroup)]
}

export function confirmQuit(groups: RunningGroup[]): Promise<boolean> {
  return confirmGroups('quit', groups)
}

export function confirmMove(workspace: Workspace, panes: readonly PaneNode[]): Promise<boolean> {
  const files = unsavedFilesOf(
    panes,
    useEditorStatus.getState().dirty,
    useEditorStatus.getState().disk,
  )
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
