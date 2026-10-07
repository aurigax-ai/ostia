import type { PaneActivity } from '@shared/types'
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
import { commandAgent } from './hibernation'
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

function agentIdle(paneId: string): boolean {
  if (agentTurnOf(paneId) !== 'idle') return false
  const state = useAttentionStore.getState().byPane[paneId]?.state
  return state !== 'working' && state !== 'waiting' && !hasPendingRequest(paneId)
}

function resumesAfterQuit(workspace: Workspace, pane: PaneNode): boolean {
  const { agents, behavior } = useSettingsStore.getState()
  if (!agents.autoResume || !behavior.restoreWorkspace || !isRestorable(workspace)) return false
  if (pane.kind !== 'terminal' || !pane.resume || pane.hibernated) return false
  return runningAgentOf(pane.id) === pane.resume.agent && agentIdle(pane.id)
}

function atNestedPrompt(paneId: string): boolean {
  const draft = useBlocksStore.getState().drafts[paneId]
  return draft !== undefined && !draft.remote
}

function hasShellIntegration(paneId: string): boolean {
  const { byPane, drafts, running } = useBlocksStore.getState()
  return (
    (byPane[paneId]?.length ?? 0) > 0 ||
    drafts[paneId] !== undefined ||
    running[paneId] !== undefined
  )
}

type PaneActivities = Readonly<Record<string, PaneActivity>>

interface RunningContext {
  kept: ReadonlySet<string>
  activity: PaneActivities
  quitting: boolean
}

const PLAIN: RunningContext = { kept: new Set(), activity: {}, quitting: false }

function runningIn(
  workspace: Workspace,
  panes: readonly PaneNode[],
  context: RunningContext,
): { commands: string[]; agents: string[] } {
  const { running, byPane } = useBlocksStore.getState()
  const commands: string[] = []
  const agents: string[] = []
  for (const pane of panes) {
    if (pane.hibernated || (context.quitting && resumesAfterQuit(workspace, pane))) continue
    const blockId = running[pane.id]
    if (blockId !== undefined) {
      if (atNestedPrompt(pane.id)) continue
      const command = byPane[pane.id]?.find((b) => b.id === blockId)?.command.trim() ?? ''
      if (runningAgent(pane.id) !== null) agents.push(command)
      else commands.push(command)
      continue
    }
    const activity = context.activity[pane.id]
    if (activity?.agentRunning) {
      agents.push(pane.resume?.agent ?? activity.program ?? '')
      continue
    }
    const program = hasShellIntegration(pane.id) ? null : (activity?.program ?? null)
    if (program === null) continue
    if (commandAgent(program)) agents.push(program)
    else commands.push(program)
  }
  return { commands, agents }
}

function groupOf(
  workspace: Workspace,
  panes: readonly PaneNode[],
  context: RunningContext = PLAIN,
): RunningGroup | null {
  const { commands, agents } = runningIn(workspace, panes, context)
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

function managerGroup(workspace: Workspace, panes: readonly PaneNode[]): RunningGroup | null {
  const manager = panes.find((p) => p.kind === 'manager')
  if (manager && agentIdle(manager.id)) return null
  const name = workspace.customName ?? workspace.name
  return { workspaceId: workspace.id, workspace: name, commands: [], agents: [name], files: [] }
}

function runningGroup(workspace: Workspace, context: RunningContext = PLAIN): RunningGroup | null {
  const layout = useLayoutStore.getState().byWorkspace[workspace.id]
  const panes = layout ? allPanes(layout.root) : []
  if (workspace.kind === 'manager') return managerGroup(workspace, panes)
  return layout
    ? groupOf(
        workspace,
        panes.filter((p) => !context.kept.has(p.id)),
        context,
      )
    : null
}

function runningGroups(
  workspaces: readonly Workspace[],
  context: RunningContext = PLAIN,
): RunningGroup[] {
  const groups: RunningGroup[] = []
  for (const workspace of workspaces) {
    const group = runningGroup(workspace, context)
    if (group) groups.push(group)
  }
  return groups
}

async function paneActivities(panes: readonly PaneNode[]): Promise<PaneActivities> {
  const activity = window.ostia?.pty?.activity
  const out: Record<string, PaneActivity> = {}
  if (!activity) return out
  const live = panes.filter((p) => p.kind === 'terminal' && !p.hibernated)
  const answers = await Promise.all(live.map((p) => activity(p.id).catch(() => null)))
  for (const [index, pane] of live.entries()) {
    const answer = answers[index]
    if (answer) out[pane.id] = answer
  }
  return out
}

function panesOf(workspaces: readonly Workspace[]): PaneNode[] {
  const { byWorkspace } = useLayoutStore.getState()
  return workspaces.flatMap((w) => {
    const layout = byWorkspace[w.id]
    return layout ? allPanes(layout.root) : []
  })
}

async function confirmGroups(kind: CloseConfirmKind, groups: RunningGroup[]): Promise<boolean> {
  if (groups.length === 0) return true
  return useCloseConfirmStore.getState().ask(kind, groups)
}

function groupsToConfirm(
  workspaces: readonly Workspace[],
  enabled: boolean,
  context: RunningContext = PLAIN,
): RunningGroup[] {
  return enabled ? runningGroups(workspaces, context) : []
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
  const activity = confirmClose ? await paneActivities(panesOf(workspaces)) : {}
  const groups = groupsToConfirm(workspaces, confirmClose, { ...PLAIN, activity })
  return withScratchGroups(workspaces, groups, counts)
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

async function paneGroup(workspace: Workspace, paneId: string): Promise<RunningGroup | null> {
  if (isManagerPane(workspace.id, paneId)) return runningGroup(workspace)
  const layout = useLayoutStore.getState().byWorkspace[workspace.id]
  const pane = layout ? findPane(layout.root, paneId) : null
  if (!pane) return null
  return groupOf(workspace, [pane], { ...PLAIN, activity: await paneActivities([pane]) })
}

export async function requestClosePane(workspaceId: string, paneId: string): Promise<void> {
  if (useLayoutStore.getState().isLocked(workspaceId, paneId)) return
  const workspace = useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId)
  const { confirmClose } = useSettingsStore.getState().workspaces
  const group = workspace && confirmClose ? await paneGroup(workspace, paneId) : null
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

export function quitGroups(
  kept: ReadonlySet<string> = new Set(),
  activity: PaneActivities = {},
): RunningGroup[] {
  const { confirmQuit: enabled } = useSettingsStore.getState().workspaces
  const { workspaces } = useWorkspacesStore.getState()
  const groups = groupsToConfirm(workspaces, enabled, { kept, activity, quitting: true })
  const scratch = workspaces.filter(
    (w) => w.kind === 'scratch' && !groups.some((g) => g.workspaceId === w.id),
  )
  return [...groups, ...scratch.map(emptyGroup)]
}

export async function collectQuitGroups(kept: ReadonlySet<string>): Promise<RunningGroup[]> {
  const { confirmQuit: enabled } = useSettingsStore.getState().workspaces
  const { workspaces } = useWorkspacesStore.getState()
  const panes = panesOf(workspaces).filter((p) => !kept.has(p.id))
  return quitGroups(kept, enabled ? await paneActivities(panes) : {})
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
