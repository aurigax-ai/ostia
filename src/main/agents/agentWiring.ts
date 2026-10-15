import { basename } from 'node:path'
import type { BrowserWindow } from 'electron'
import { parseAgentHooks } from '../../shared/agents/agentHooks'
import { isResumableAgent } from '../../shared/agents/agentResume'
import { managerAgents } from '../../shared/agents/managerSettings'
import type { ManagerSettings } from '../../shared/agents/managerSettings'
import type { ChangeSignal } from '../../shared/common/actThenConfirm'
import type { CommandTarget, TerminalStateSnapshot } from '../../shared/types'
import type { CommandResult } from '../../shared/types'
import type { Reach } from '../approvals/reach'
import { registerAttentionMethods, targetOf } from '../attention/attention'
import { getByPaneId } from '../control/idRegistry'
import type { Telemetry } from '../diagnostics/telemetry'
import type { OwnerLookup } from '../extensions/workspaceChips'
import type { ManagerService } from '../manager/manager'
import type { PaneIo } from '../panes/paneIo'
import { registerPaneRenameMethods } from '../panes/paneRename'
import { registerPaneResumeMethods } from '../panes/paneResume'
import type { PaneWatch } from '../panes/paneWait'
import type { PaneWaking } from '../panes/paneWaking'
import type { ProcessTabRequest } from '../panes/processLaunch'
import { INTERRUPT_GRACE_MS, registerProcessMethods } from '../panes/processManager'
import type { ProcessRegistry } from '../panes/processRegistry'
import { readSettingsFile } from '../platform/settingsFile'
import type { WorkspaceSandboxes } from '../sandbox/workspaceSandboxes'
import type { PaneTitleEntry, PtyEntry } from '../terminal/pty/ptyRegistry'
import type { ReapReason } from '../terminal/ptyReaper'
import type { KeptAttention } from '../tmux/keptAttention'
import type { AgentRunningPanes } from './agentRunning'
import { type ReportedAgentWork, registerAgentWorkMethods } from './agentWork'
import { tellPane } from './bus'

interface AgentWiringDeps {
  execCommand: (
    target: CommandTarget,
    id: string,
    args?: unknown,
    fromMain?: boolean,
  ) => Promise<CommandResult>
  keptAttention: KeptAttention
  agentWork: ReportedAgentWork
  reach: Reach
  workspaceWindowId: OwnerLookup
  services: {
    managerService: ManagerService | null
    processes: ProcessRegistry | null
    telemetry: Telemetry | null
  }
  paneWaking: PaneWaking
  startedAgents: Set<string>
  agentChanges: ChangeSignal
  openTerminalInWindow: (req: ProcessTabRequest) => Promise<string | null>
  syncKeptMeta: (paneId: string) => void
  paneWatch: PaneWatch
  ptys: Map<string, PtyEntry>
  paneIo: PaneIo
  workspaceSandboxes: WorkspaceSandboxes
  killPty: (paneId: string, reason: ReapReason) => void
  windows: Map<string, BrowserWindow>
  terminalState: Map<string, TerminalStateSnapshot>
  managerSettings: () => ManagerSettings
  agentRunning: AgentRunningPanes
  workspaceCommandTarget: (workspaceId: string) => CommandTarget
}

export function registerAgentWiring({
  execCommand,
  keptAttention,
  agentWork,
  reach,
  workspaceWindowId,
  services,
  paneWaking,
  startedAgents,
  agentChanges,
  openTerminalInWindow,
  syncKeptMeta,
  paneWatch,
  ptys,
  paneIo,
  workspaceSandboxes,
  killPty,
  windows,
  terminalState,
  managerSettings,
  agentRunning,
  workspaceCommandTarget,
}: AgentWiringDeps) {
  registerAttentionMethods({ execCommand, reported: (paneId) => keptAttention.reported(paneId) })
  registerAgentWorkMethods(agentWork)
  registerPaneRenameMethods({ execCommand, reach, windowOfWorkspace: workspaceWindowId })
  registerPaneResumeMethods({
    execCommand,
    onResume: (identity, resume) => {
      services.telemetry?.count('agents', 'resume')
      paneWaking.end(identity.paneId, 'started')
      startedAgents.add(identity.paneId)
      agentChanges.fire()
      if (identity.manager) services.managerService?.rememberResume(resume)
    },
  })
  const registry = registerProcessMethods({
    openTab: openTerminalInWindow,
    onChange: (entry) => {
      syncKeptMeta(entry.paneId)
      paneWatch.emit(entry.paneId, { kind: 'state' })
    },
    ring: (paneId) => {
      const session = ptys.get(paneId)?.session
      return session ? (from) => session.since(from) : undefined
    },
    writePane: paneIo.write,
    isSandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId),
    endShell: (paneId) => killPty(paneId, 'process-kill'),
    hasShell: (paneId) => ptys.has(paneId),
    runInPane: (paneId, command) => {
      const windowId = getByPaneId(paneId)?.windowId
      const win = windowId ? windows.get(windowId) : undefined
      if (!win || win.isDestroyed()) return false
      win.webContents.send('pty:run', paneId, command)
      return true
    },
    cwdOfPane: (paneId) => terminalState.get(paneId)?.cwd,
    agentArgv: (name) => managerAgents(managerSettings())[name] ?? null,
    isAgent: (paneId) => agentRunning.has(paneId),
    agentStarted: (paneId) => startedAgents.has(paneId),
    startsWithHook: (argv) => {
      const program = basename(argv[0] ?? '')
      return isResumableAgent(program) && parseAgentHooks(readSettingsFile().agents?.hooks)[program]
    },
    agentChanges: agentChanges.subscribe,
    tell: tellPane,
    splitTabNow: async (workspaceId, paneId) => {
      const target = workspaceCommandTarget(workspaceId)
      const res = await execCommand(target, 'pane.splitTabOf', { paneId }, true)
      return res.ok ? (res.result as { name: string | null; human: boolean }) : null
    },
    humanTab: async (workspaceId, name) => {
      const target = workspaceCommandTarget(workspaceId)
      const res = await execCommand(target, 'pane.tabPlan', { paneIds: [], tab: name }, true)
      return res.ok && typeof (res.result as { human?: unknown }).human === 'string'
    },
    paneTitle: async (paneId) => {
      const pane = getByPaneId(paneId)
      if (!pane) return undefined
      const res = await execCommand({ ...targetOf(pane), paneId: null }, 'pane.list')
      const panes = res.ok && Array.isArray(res.result) ? (res.result as PaneTitleEntry[]) : []
      return panes.find((p) => p.paneId === paneId)?.title
    },
    reach,
    interruptGraceMs: INTERRUPT_GRACE_MS,
  })
  services.processes = registry

  return { registry }
}
