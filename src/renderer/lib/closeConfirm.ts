import { allPanes, findPane } from '../layout/tree'
import type { PaneNode } from '../layout/types'
import { agentTurnOf } from '../stores/agentTurnStore'
import { useApprovalsStore } from '../stores/approvalsStore'
import { useAttentionStore } from '../stores/attentionStore'
import { type CommandBlock, useBlocksStore } from '../stores/blocksStore'
import {
  type CloseConfirmKind,
  type RunningGroup,
  useCloseConfirmStore,
} from '../stores/closeConfirmStore'
import { type DiskProblem, useEditorStatus } from '../stores/editorStatusStore'
import { useLayoutStore } from '../stores/layoutStore'
import { isRestorable } from '../stores/persistence'
import { useQuestionsStore } from '../stores/questionsStore'
import { useSettingsStore } from '../stores/settingsStore'
import { type Workspace, useWorkspacesStore } from '../stores/workspacesStore'
import { runningAgent, runningAgentOf } from './paneAgent'

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

function hasPendingRequest(paneId: string): boolean {
  return (
    useApprovalsStore.getState().pending.some((r) => r.paneId === paneId) ||
    useQuestionsStore.getState().pending.some((r) => r.paneId === paneId)
  )
}

function resumesAfterQuit(workspace: Workspace, pane: PaneNode): boolean {
  const { agents, behavior } = useSettingsStore.getState()
  if (!agents.autoResume || !behavior.restoreWorkspace || !isRestorable(workspace)) return false
  if (pane.kind !== 'terminal' || !pane.resume || pane.hibernated) return false
  if (runningAgentOf(pane.id) !== pane.resume.agent || agentTurnOf(pane.id) !== 'idle') return false
  const state = useAttentionStore.getState().byPane[pane.id]?.state
  return state !== 'working' && state !== 'waiting' && !hasPendingRequest(pane.id)
}

type PaneFilter = (pane: PaneNode) => boolean

function groupOf(
  workspace: Workspace,
  panes: readonly PaneNode[],
  resumes: PaneFilter = () => false,
): RunningGroup | null {
  const { running, byPane } = useBlocksStore.getState()
  const live = panes.filter((p) => running[p.id] !== undefined && !resumes(p))
  const isAgent = (p: PaneNode): boolean => runningAgent(p.id) !== null
  const commands = runningCommandsOf(
    live.filter((p) => !isAgent(p)).map((p) => p.id),
    running,
    byPane,
  )
  const agents = runningCommandsOf(live.filter(isAgent).map((p) => p.id), running, byPane)
  const files = unsavedFilesOf(
    panes,
    useEditorStatus.getState().dirty,
    useEditorStatus.getState().disk,
  )
  if (commands.length === 0 && agents.length === 0 && files.length === 0) return null
  return {
    workspaceId: workspace.id,
    workspace: workspace.customName ?? workspace.name,
    commands,
    ...(agents.length > 0 ? { agents } : {}),
    files,
  }
}

function runningGroup(
  workspace: Workspace,
  kept: ReadonlySet<string> = new Set(),
  resumes?: PaneFilter,
): RunningGroup | null {
  if (workspace.kind === 'manager') {
    const name = workspace.customName ?? workspace.name
    return { workspaceId: workspace.id, workspace: name, commands: [], agents: [name], files: [] }
  }
  const layout = useLayoutStore.getState().byWorkspace[workspace.id]
  return layout
    ? groupOf(
        workspace,
        allPanes(layout.root).filter((p) => !kept.has(p.id)),
        resumes,
      )
    : null
}

function runningGroups(
  workspaces: readonly Workspace[],
  kept: ReadonlySet<string> = new Set(),
  quitting = false,
): RunningGroup[] {
  const groups: RunningGroup[] = []
  for (const workspace of workspaces) {
    const resumes = quitting ? (p: PaneNode) => resumesAfterQuit(workspace, p) : undefined
    const group = runningGroup(workspace, kept, resumes)
    if (group) groups.push(group)
  }
  return groups
}

async function confirmGroups(kind: CloseConfirmKind, groups: RunningGroup[]): Promise<boolean> {
  if (groups.length === 0) return true
  return useCloseConfirmStore.getState().ask(kind, groups)
}

function groupsToConfirm(
  workspaces: readonly Workspace[],
  enabled: boolean,
  kept: ReadonlySet<string> = new Set(),
  quitting = false,
): RunningGroup[] {
  return enabled ? runningGroups(workspaces, kept, quitting) : []
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
    counts[workspace.id] = await window.ostia.scratch.files(workspace.id).catch(() => 0)
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

export function quitGroups(kept: ReadonlySet<string> = new Set()): RunningGroup[] {
  const { confirmQuit: enabled } = useSettingsStore.getState().workspaces
  const { workspaces } = useWorkspacesStore.getState()
  const groups = groupsToConfirm(workspaces, enabled, kept, true)
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

export interface QuitLosses {
  processes: number
  agents: number
  files: number
  scratchFiles: number
}

export function quitLosses(groups: readonly RunningGroup[]): QuitLosses {
  const losses: QuitLosses = { processes: 0, agents: 0, files: 0, scratchFiles: 0 }
  for (const group of groups) {
    losses.processes += group.commands.length
    losses.agents += group.agents?.length ?? 0
    losses.files += group.files.length
    losses.scratchFiles += group.scratchFiles ?? 0
  }
  return losses
}
