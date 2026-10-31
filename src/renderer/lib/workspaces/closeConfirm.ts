import { isResumableAgent } from '@shared/agents/agentResume'
import type { PaneActivity } from '@shared/terminal/ptyApi'
import { AGENT_CLOSE_SAVE_WAIT_MS, QUIT_SAVE_WAIT_MS } from '@shared/windows/closeWaits'
import type { QuitAnswer } from '@shared/windows/windowsApi'
import { runningAgent, runningAgentOf } from '@/lib/agents/paneAgent'
import { settleSaves } from '@/lib/files/pendingSaves'
import { allPanes, findPane, findSplitTab, tabIdOf, tabsOfPane } from '@/lib/layout/tree'
import type { PaneNode } from '@/lib/layout/types'
import { hasReplacedShell } from '@/lib/terminal/replacedShells'
import { workspaceTitle } from '@/lib/workspaces/workspaceTitle'
import { useApprovalsStore } from '@/stores/agents/approvalsStore'
import { useAttentionStore } from '@/stores/agents/attentionStore'
import { useQuestionsStore } from '@/stores/agents/questionsStore'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { type DiskProblem, useEditorStatus } from '@/stores/files/editorStatusStore'
import { agentTurnOf } from '@/stores/terminal/agentTurnStore'
import { type CommandBlock, useBlocksStore } from '@/stores/terminal/blocksStore'
import {
  type CloseConfirmKind,
  type RunningGroup,
  useCloseConfirmStore,
} from '@/stores/workspaces/closeConfirmStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { isRestorable } from '@/stores/workspaces/persistence'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import type { Workspace } from '@/stores/workspaces/workspaceTypes'

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
    if (pane.hibernated || hasReplacedShell(pane.id)) continue
    if (context.quitting && resumesAfterQuit(workspace, pane)) continue
    const blockId = running[pane.id]
    const activity = context.activity[pane.id]
    if (blockId !== undefined) {
      if (atNestedPrompt(pane.id)) continue
      const typed = byPane[pane.id]?.find((b) => b.id === blockId)?.command.trim() ?? ''
      const command = typed || activity?.program || ''
      const agent = runningAgent(pane.id)
      if (agent === null) commands.push(command)
      else agents.push(command || (agent === 'other' ? '' : agent))
      continue
    }
    if (activity?.agentRunning) {
      agents.push(pane.resume?.agent ?? activity.program ?? '')
      continue
    }
    const program = hasShellIntegration(pane.id) ? null : (activity?.program ?? null)
    if (program === null) continue
    if (isResumableAgent(program)) agents.push(program)
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
    workspace: workspaceTitle(workspace),
    commands,
    ...(agents.length > 0 ? { agents } : {}),
    files,
  }
}

function managerGroup(workspace: Workspace, panes: readonly PaneNode[]): RunningGroup | null {
  const manager = panes.find((p) => p.kind === 'manager')
  if (manager && agentIdle(manager.id)) return null
  const name = workspaceTitle(workspace)
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

async function paneActivities(
  panes: readonly PaneNode[],
  saveWaitMs?: number,
): Promise<PaneActivities> {
  const out: Record<string, PaneActivity> = {}
  const files = panes.flatMap((p) => (p.kind === 'editor' && p.filePath ? [p.filePath] : []))
  const live = panes.filter((p) => p.kind === 'terminal' && !p.hibernated)
  const [, answers] = await Promise.all([
    settleSaves(files, saveWaitMs),
    Promise.all(live.map((p) => window.ostia.pty.activity(p.id).catch(() => null))),
  ])
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
    workspace: workspaceTitle(workspace),
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

export async function closeBlockers(workspace: Workspace): Promise<RunningGroup | null> {
  const scratch =
    workspace.kind === 'scratch' ? await window.ostia.scratch.files(workspace.id).catch(() => 0) : 0
  const activity = await paneActivities(panesOf([workspace]))
  const groups = runningGroups([workspace], { ...PLAIN, activity })
  return withScratchGroups([workspace], groups, { [workspace.id]: scratch })[0] ?? null
}

export async function requestCloseOthers(id: string): Promise<void> {
  const others = useWorkspacesStore
    .getState()
    .workspaces.filter((w) => w.id !== id && !useLayoutStore.getState().isLocked(w.id))
  if (await confirmGroups('workspace', await closeGroups(others))) {
    useWorkspacesStore.getState().closeOthers(id)
  }
}

const closable = (pane: PaneNode): boolean => pane.kind !== 'manager' && !pane.locked

export function closableOtherTabPanes(workspaceId: string, paneId: string): PaneNode[] {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId]
  const tabs = layout ? tabsOfPane(layout.root, paneId) : null
  const keep = layout ? tabIdOf(layout.root, paneId) : null
  if (!tabs || !keep) return []
  return tabs.children
    .filter((tab) => tab.id !== keep)
    .flatMap((tab) => allPanes(tab))
    .filter(closable)
}

function closableSplitTabPanes(workspaceId: string, tabId: string): PaneNode[] {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId]
  const tab = layout ? findSplitTab(layout.root, tabId) : null
  return tab ? allPanes(tab).filter(closable) : []
}

async function requestClosePanes(workspaceId: string, panes: PaneNode[]): Promise<void> {
  const workspace = useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId)
  if (!workspace || panes.length === 0) return
  const { confirmClose } = useSettingsStore.getState().workspaces
  const group = confirmClose
    ? groupOf(workspace, panes, { ...PLAIN, activity: await paneActivities(panes) })
    : null
  if (await confirmGroups('pane', group ? [group] : [])) {
    for (const pane of panes) useLayoutStore.getState().closePane(workspaceId, pane.id)
  }
}

export function requestCloseOtherTabs(workspaceId: string, paneId: string): Promise<void> {
  return requestClosePanes(workspaceId, closableOtherTabPanes(workspaceId, paneId))
}

export function requestCloseSplitTab(workspaceId: string, tabId: string): Promise<void> {
  return requestClosePanes(workspaceId, closableSplitTabPanes(workspaceId, tabId))
}

function isManagerPane(workspaceId: string, paneId: string): boolean {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId]
  return layout ? findPane(layout.root, paneId)?.kind === 'manager' : false
}

async function paneGroup(
  workspace: Workspace,
  paneId: string,
  saveWaitMs?: number,
): Promise<RunningGroup | null> {
  if (isManagerPane(workspace.id, paneId)) return runningGroup(workspace)
  const layout = useLayoutStore.getState().byWorkspace[workspace.id]
  const pane = layout ? findPane(layout.root, paneId) : null
  if (!pane) return null
  const activity = await paneActivities([pane], saveWaitMs)
  return groupOf(workspace, [pane], { ...PLAIN, activity })
}

async function askClosePane(
  workspaceId: string,
  paneId: string,
  saveWaitMs?: number,
): Promise<void> {
  if (useLayoutStore.getState().isLocked(workspaceId, paneId)) return
  const workspace = useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId)
  const { confirmClose } = useSettingsStore.getState().workspaces
  const group = workspace && confirmClose ? await paneGroup(workspace, paneId, saveWaitMs) : null
  if (await confirmGroups('pane', group ? [group] : [])) {
    useLayoutStore.getState().closePane(workspaceId, paneId)
  }
}

export function requestClosePane(workspaceId: string, paneId: string): Promise<void> {
  return askClosePane(workspaceId, paneId)
}

export async function closePaneForAgent(workspaceId: string, paneId: string): Promise<void> {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId]
  const pane = layout ? findPane(layout.root, paneId) : null
  if (pane?.kind === 'editor' && pane.filePath) {
    await settleSaves([pane.filePath], AGENT_CLOSE_SAVE_WAIT_MS)
  }
  const { dirty, disk } = useEditorStatus.getState()
  const asks = pane?.kind === 'manager' || (pane && unsavedFilesOf([pane], dirty, disk).length > 0)
  if (asks) await askClosePane(workspaceId, paneId, 0)
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
  return quitGroups(kept, enabled ? await paneActivities(panes, QUIT_SAVE_WAIT_MS) : {})
}

export async function confirmQuit(
  groups: RunningGroup[],
  keptShells: readonly string[] = [],
): Promise<QuitAnswer> {
  if (keptShells.length === 0) {
    return confirmGroups('quit', groups).then((confirmed) => (confirmed ? 'quit' : 'cancel'))
  }
  const ids = new Set(keptShells)
  const { workspaces } = useWorkspacesStore.getState()
  const activity = await paneActivities(panesOf(workspaces).filter((p) => ids.has(p.id)))
  return useCloseConfirmStore.getState().askQuit(groups, [...keptShells], activity)
}

export function keptRunning(
  paneIds: readonly string[],
  activity: PaneActivities = {},
): { commands: string[]; agents: string[] } {
  const ids = new Set(paneIds)
  const kept = { commands: [] as string[], agents: [] as string[] }
  for (const workspace of useWorkspacesStore.getState().workspaces) {
    const panes = panesOf([workspace]).filter((pane) => ids.has(pane.id))
    const { commands, agents } = runningIn(workspace, panes, { ...PLAIN, activity })
    kept.commands.push(...commands)
    kept.agents.push(...agents)
  }
  return kept
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
      workspace: workspaceTitle(workspace),
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
