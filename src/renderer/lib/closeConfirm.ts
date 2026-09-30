import { paneIds } from '../layout/tree'
import { type CommandBlock, useBlocksStore } from '../stores/blocksStore'
import {
  type CloseConfirmKind,
  type RunningGroup,
  useCloseConfirmStore,
} from '../stores/closeConfirmStore'
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

function runningGroup(workspace: Workspace): RunningGroup | null {
  const name = workspace.customName ?? workspace.name
  if (workspace.kind === 'manager') {
    return { workspaceId: workspace.id, workspace: name, commands: [name] }
  }
  const layout = useLayoutStore.getState().byWorkspace[workspace.id]
  if (!layout) return null
  const { running, byPane } = useBlocksStore.getState()
  const commands = runningCommandsOf(paneIds(layout.root), running, byPane)
  if (commands.length === 0) return null
  return {
    workspaceId: workspace.id,
    workspace: workspace.customName ?? workspace.name,
    commands,
  }
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

export async function requestClosePane(workspaceId: string, paneId: string): Promise<void> {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId]
  const workspace = useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId)
  const isLast = !!layout && paneIds(layout.root).length === 1
  const { confirmClose } = useSettingsStore.getState().workspaces
  const groups = isLast && workspace ? groupsToConfirm([workspace], confirmClose) : []
  if (await confirmGroups('pane', groups)) {
    useLayoutStore.getState().closePane(workspaceId, paneId)
  }
}

export function confirmQuit(): Promise<boolean> {
  const { confirmQuit: enabled } = useSettingsStore.getState().workspaces
  return confirmGroups('quit', groupsToConfirm(useWorkspacesStore.getState().workspaces, enabled))
}
