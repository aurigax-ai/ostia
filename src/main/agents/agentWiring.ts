import { basename } from 'node:path'
import type { BrowserWindow } from 'electron'
import { parseAgentHooks } from '../../shared/agents/agentHooks'
import { isResumableAgent } from '../../shared/agents/agentResume'
import type { ManagerSettings } from '../../shared/agents/managerSettings'
import { managerAgents } from '../../shared/agents/managerSettings'
import type { ChangeSignal } from '../../shared/common/actThenConfirm'
import type { CommandTarget } from '../../shared/control/commands'
import type { TerminalStateSnapshot } from '../../shared/terminal/ptyApi'
import type { Reach } from '../approvals/reach'
import { registerAttentionMethods, targetOf } from '../attention/attention'
import type { CommandBridge } from '../control/commandBridge'
import { getByPaneId } from '../control/idRegistry'
import type { Telemetry } from '../diagnostics/telemetry'
import type { ManagerService } from '../manager/manager'
import type { ManagerLimiter } from '../manager/managerMethods'
import type { PaneJournal } from '../panes/paneJournal'
import { registerPaneKeepAwakeMethods } from '../panes/paneKeepAwake'
import { registerPaneNameMethods } from '../panes/paneNameMethods'
import { noteAgentSession } from '../panes/paneNames'
import { registerPaneRenameMethods } from '../panes/paneRename'
import {
  type PaneResumeDeps,
  refreshResumeFolder,
  registerPaneResumeMethods,
} from '../panes/paneResume'
import { type PaneTurns, registerPaneTurnMethods } from '../panes/paneTurns'
import type { PaneWatch } from '../panes/paneWait'
import type { PaneWaking } from '../panes/paneWaking'
import { INTERRUPT_GRACE_MS, registerProcessMethods } from '../panes/processManager'
import type { ProcessRegistry } from '../panes/processRegistry'
import { readSettingsFile } from '../platform/settingsFile'
import type { WorkspaceSandboxes } from '../sandbox/workspaceSandboxes'
import type { PtyIo } from '../terminal/pty/ptyIo'
import type { PaneTitleEntry, PtyEntry } from '../terminal/pty/ptyRegistry'
import type { ReapReason } from '../terminal/ptyReaper'
import type { KeptAttention } from '../tmux/keptAttention'
import type { KeptShellsWiring } from '../tmux/keptShellsWiring'
import type { WindowSend } from '../windows/windowSend'
import type { AgentResumes } from './agentResumes'
import type { AgentRunningPanes } from './agentRunning'
import { codexSessionFolder } from './agentTranscript'
import { type ReportedAgentWork, registerAgentWorkMethods } from './agentWork'
import { tellPane } from './busStore'

interface AgentWiringDeps {
  execCommand: CommandBridge['execCommand']
  keptAttention: KeptAttention
  agentWork: ReportedAgentWork
  paneTurns: PaneTurns
  reach: Reach
  workspaceWindowId: WindowSend['workspaceWindowId']
  services: {
    managerService: ManagerService | null
    managerLimiter: ManagerLimiter | null
    processes: ProcessRegistry | null
    telemetry: Telemetry | null
  }
  paneWaking: PaneWaking
  startedAgents: Set<string>
  agentChanges: ChangeSignal
  agentResumes: AgentResumes
  openTerminalInWindow: CommandBridge['openTerminalInWindow']
  syncKeptMeta: KeptShellsWiring['syncKeptMeta']
  paneWatch: PaneWatch
  paneJournal: PaneJournal
  ptys: Map<string, PtyEntry>
  paneIo: PtyIo['paneIo']
  workspaceSandboxes: WorkspaceSandboxes
  killPty: (paneId: string, reason: ReapReason) => void
  windows: Map<string, BrowserWindow>
  terminalState: Map<string, TerminalStateSnapshot>
  managerSettings: () => ManagerSettings
  agentRunning: AgentRunningPanes
  workspaceCommandTarget: (workspaceId: string) => CommandTarget
  foregroundProgram: (paneId: string) => string | null
  agentCwd: (paneId: string) => Promise<string | null>
}

export type AgentWiring = ReturnType<typeof registerAgentWiring>

export function registerAgentWiring({
  execCommand,
  keptAttention,
  agentWork,
  paneTurns,
  reach,
  workspaceWindowId,
  services,
  paneWaking,
  startedAgents,
  agentChanges,
  agentResumes,
  openTerminalInWindow,
  syncKeptMeta,
  paneWatch,
  paneJournal,
  ptys,
  paneIo,
  workspaceSandboxes,
  killPty,
  windows,
  terminalState,
  managerSettings,
  agentRunning,
  workspaceCommandTarget,
  foregroundProgram,
  agentCwd,
}: AgentWiringDeps) {
  registerAttentionMethods({
    execCommand,
    reported: (paneId) => keptAttention.reported(paneId),
    closing: (paneId, state, message, stop) => paneJournal.report(paneId, state, message, stop),
  })
  registerAgentWorkMethods(agentWork)
  const resumeDeps: PaneResumeDeps = {
    execCommand,
    foregroundProgram,
    agentCwd,
    sessionFolder: codexSessionFolder,
    onResume: (identity, resume) => {
      services.telemetry?.count('agents', 'resume')
      paneWaking.end(identity.paneId, 'started')
      startedAgents.add(identity.paneId)
      agentChanges.fire()
      noteAgentSession(identity.paneId, resume.agent, resume.id)
      agentResumes.emit(identity.externalId, resume)
      if (identity.manager) services.managerService?.rememberResume(resume)
    },
  }
  registerPaneResumeMethods(resumeDeps)
  registerPaneTurnMethods(paneTurns, (identity) => {
    void refreshResumeFolder(resumeDeps, identity).catch(() => {})
  })
  const listedPane = async (
    paneId: string,
  ): Promise<(PaneTitleEntry & { agentSessionId?: string }) | undefined> => {
    const pane = getByPaneId(paneId)
    if (!pane) return undefined
    const res = await execCommand({ ...targetOf(pane), paneId: null }, 'pane.list')
    const panes =
      res.ok && Array.isArray(res.result)
        ? (res.result as (PaneTitleEntry & { agentSessionId?: string })[])
        : []
    return panes.find((p) => p.paneId === paneId)
  }
  const { registry, startAgentForPhone } = registerProcessMethods({
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
    isConfined: (paneId) => ptys.get(paneId)?.sandboxed === true,
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
    paneTitle: async (paneId) => (await listedPane(paneId))?.title,
    agentSession: async (paneId) => (await listedPane(paneId))?.agentSessionId,
    turnState: async (paneId) => {
      const pane = getByPaneId(paneId)
      if (!pane) return undefined
      const kept = keptAttention.peek(paneId)
      if (kept) return kept.state
      const res = await execCommand(targetOf(pane), 'attention.peek')
      return res.ok && res.result && typeof res.result === 'object'
        ? (res.result as { state?: string }).state
        : undefined
    },
    reach,
    managerAdmitSpawn: (liveWorkers) => services.managerLimiter?.admitSpawn(liveWorkers) ?? null,
    interruptGraceMs: INTERRUPT_GRACE_MS,
  })
  services.processes = registry
  const processPane = async (ref: string, ctx: Parameters<typeof reach.visible>[0]) =>
    registry
      .livePanes(ref, ctx.identity.workspaceId, await reach.visible(ctx))
      .map((entry) => entry.paneId)
  registerPaneNameMethods({
    visible: reach.visible,
    isSandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId),
    isConfined: (paneId) => ptys.get(paneId)?.sandboxed === true,
    processPane,
    agentRunning: (paneId) => agentRunning.has(paneId),
  })
  registerPaneKeepAwakeMethods({
    execCommand,
    agentRunning: (paneId) => agentRunning.has(paneId),
  })
  registerPaneRenameMethods({
    execCommand,
    reach,
    windowOfWorkspace: workspaceWindowId,
    isSandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId),
    isConfined: (paneId) => ptys.get(paneId)?.sandboxed === true,
    processPane,
  })

  return { registry, startAgentForPhone }
}
