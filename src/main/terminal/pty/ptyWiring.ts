import type { BrowserWindow } from 'electron'
import type { TerminalStateSnapshot } from '../../../shared/types'
import type { AgentRunningPanes } from '../../agents/agentRunning'
import type { ReportedAgentWork } from '../../agents/agentWork'
import type { ArtifactFolders } from '../../artifacts/artifactFolders'
import type { PaneIdentity } from '../../control/idRegistry'
import type { AppLog } from '../../diagnostics/appLog'
import type { Telemetry } from '../../diagnostics/telemetry'
import type { OpenWaits } from '../../files/openWaits'
import type { PaneWaking } from '../../panes/paneWaking'
import type { ProcessRegistry } from '../../panes/processRegistry'
import { readSettingsFile } from '../../platform/settingsFile'
import type { HostPaneGrants } from '../../sandbox/hostPanes'
import type { PortRequests } from '../../sandbox/portRequests'
import type { WorkspaceSandboxes } from '../../sandbox/workspaceSandboxes'
import type { SavedAttention } from '../../tmux/attentionFile'
import type { KeptAttention } from '../../tmux/keptAttention'
import { createKeptReattach } from '../../tmux/keptReattach'
import type { KeptShellsWiring } from '../../tmux/keptShellsWiring'
import { createKeptSpawner } from '../../tmux/keptSpawn'
import type { ScratchFolders } from '../../workspaces/scratchFolders'
import type { WorkspaceLifecycle } from '../../workspaces/workspaceLifecycle'
import type { PaneHistories } from '../history/paneHistories'
import { createPtyAttach } from './ptyAttach'
import { createPtyIo } from './ptyIo'
import { createLiveAttach } from './ptyLiveAttach'
import { createPtyQueries } from './ptyQueries'
import { createPtyRecovery } from './ptyRecovery'
import { type PtyEntry, createPtyRegistry } from './ptyRegistry'
import type { PtyRegistry } from './ptyRegistry'
import { createSandboxSpawn } from './ptySandboxSpawn'
import { createSpawnPlanner } from './ptySpawnPlan'
import { createPtyStart } from './ptyStart'
import { createPtyStop } from './ptyStop'

interface PtyWiringDeps {
  ptys: Map<string, PtyEntry>
  movingPanes: Set<string>
  recoveryHeld: Set<string>
  closedPanes: Set<string>
  openWaits: OpenWaits
  agentRunning: AgentRunningPanes
  agentWork: ReportedAgentWork
  keptAttention: KeptAttention
  services: {
    appLog: AppLog | null
    onSandboxSpawnFailure: ((workspaceId: string, errors: string[]) => void) | null
    processes: ProcessRegistry | null
    telemetry: Telemetry | null
    histories: PaneHistories | null
  }
  hibernatedPanes: Set<string>
  startedAgents: Set<string>
  terminalState: Map<string, TerminalStateSnapshot>
  keptShells: KeptShellsWiring['keptShells']
  paneWaking: PaneWaking
  workspaceSandboxes: WorkspaceSandboxes
  injectSecrets: (workspaceId: string) => Promise<{ env: Record<string, string>; notice: string }>
  keptPlumbing: KeptShellsWiring['keptPlumbing']
  portRequests: PortRequests
  releaseMergedSandbox: WorkspaceLifecycle['releaseMergedSandbox']
  restoreKeptAttention: (identity: PaneIdentity, saved: SavedAttention) => void
  windows: Map<string, BrowserWindow>
  scratchFolders: ScratchFolders
  artifactFolders: ArtifactFolders
  hostPaneGrants: HostPaneGrants
  paneLauncherDir: KeptShellsWiring['paneLauncherDir']
  keepShellsOn: KeptShellsWiring['keepShellsOn']
  keptShellsProgram: KeptShellsWiring['keptShellsProgram']
  withKeptProcess: KeptShellsWiring['withKeptProcess']
  keptPaneEnv: KeptShellsWiring['keptPaneEnv']
}

export function createPtyWiring({
  ptys,
  movingPanes,
  recoveryHeld,
  closedPanes,
  openWaits,
  agentRunning,
  agentWork,
  keptAttention,
  services,
  hibernatedPanes,
  startedAgents,
  terminalState,
  keptShells,
  paneWaking,
  workspaceSandboxes,
  injectSecrets,
  keptPlumbing,
  portRequests,
  releaseMergedSandbox,
  restoreKeptAttention,
  windows,
  scratchFolders,
  artifactFolders,
  hostPaneGrants,
  paneLauncherDir,
  keepShellsOn,
  keptShellsProgram,
  withKeptProcess,
  keptPaneEnv,
}: PtyWiringDeps) {
  const { loadPty, feedPty, trackPty } = createPtyRegistry({
    ptys,
    movingPanes,
    recoveryHeld,
    closedPanes,
    scheduleReap: (paneId, entry) => scheduleReap(paneId, entry),
    openWaits,
    agentRunning,
    agentWork,
    keptAttention,
    processes: () => services.processes,
    appLog: () => services.appLog,
    histories: () => services.histories,
  })

  const { killPty, hibernatePty } = createPtyStop({
    ptys,
    recoveryHeld,
    closedPanes,
    hibernatedPanes,
    startedAgents,
    terminalState,
    keptShells,
    agentWork,
    paneWaking,
    telemetry: () => services.telemetry,
    appLog: () => services.appLog,
  })

  const { paneActivity, sandboxReadRules, ptyPid, paneOutput } = createPtyQueries({
    ptys,
    agentRunning,
    workspaceSandboxes,
  })

  const {
    paneIo,
    releasePtyFlow,
    hidePtyFlow,
    attachMirror,
    ptyResize,
    ptyWrite,
    attachPhoneObserver,
  } = createPtyIo({
    ptys,
  })

  const {
    windowOfPane,
    scheduleReap,
    startRecovery,
    finishRecovery,
    releaseWindowPtys,
    holdPtys,
    releaseMovingPane,
  } = createPtyRecovery({
    ptys,
    movingPanes,
    recoveryHeld,
    closedPanes,
    killPty,
    appLog: () => services.appLog,
  })
  const { attachPty } = createPtyAttachWiring({
    workspaceSandboxes,
    keptShells,
    injectSecrets,
    services,
    keptPlumbing,
    keptAttention,
    agentRunning,
    hibernatedPanes,
    portRequests,
    trackPty,
    feedPty,
    releaseMergedSandbox,
    restoreKeptAttention,
    windows,
    movingPanes,
    recoveryHeld,
    scratchFolders,
    artifactFolders,
    hostPaneGrants,
    paneLauncherDir,
    keepShellsOn,
    keptShellsProgram,
    withKeptProcess,
    keptPaneEnv,
    ptys,
    loadPty,
  })

  return {
    loadPty,
    feedPty,
    trackPty,
    killPty,
    hibernatePty,
    paneActivity,
    sandboxReadRules,
    ptyPid,
    paneOutput,
    paneIo,
    releasePtyFlow,
    hidePtyFlow,
    attachMirror,
    ptyResize,
    ptyWrite,
    attachPhoneObserver,
    windowOfPane,
    startRecovery,
    finishRecovery,
    releaseWindowPtys,
    holdPtys,
    releaseMovingPane,
    attachPty,
  }
}

interface PtyAttachWiringDeps {
  workspaceSandboxes: WorkspaceSandboxes
  keptShells: KeptShellsWiring['keptShells']
  injectSecrets: (workspaceId: string) => Promise<{ env: Record<string, string>; notice: string }>
  services: {
    appLog: AppLog | null
    onSandboxSpawnFailure: ((workspaceId: string, errors: string[]) => void) | null
    processes: ProcessRegistry | null
    telemetry: Telemetry | null
  }
  keptPlumbing: KeptShellsWiring['keptPlumbing']
  keptAttention: KeptAttention
  agentRunning: AgentRunningPanes
  hibernatedPanes: Set<string>
  portRequests: PortRequests
  trackPty: PtyRegistry['trackPty']
  feedPty: PtyRegistry['feedPty']
  releaseMergedSandbox: WorkspaceLifecycle['releaseMergedSandbox']
  restoreKeptAttention: (identity: PaneIdentity, saved: SavedAttention) => void
  windows: Map<string, BrowserWindow>
  movingPanes: Set<string>
  recoveryHeld: Set<string>
  scratchFolders: ScratchFolders
  artifactFolders: ArtifactFolders
  hostPaneGrants: HostPaneGrants
  paneLauncherDir: KeptShellsWiring['paneLauncherDir']
  keepShellsOn: KeptShellsWiring['keepShellsOn']
  keptShellsProgram: KeptShellsWiring['keptShellsProgram']
  withKeptProcess: KeptShellsWiring['withKeptProcess']
  keptPaneEnv: KeptShellsWiring['keptPaneEnv']
  ptys: Map<string, PtyEntry>
  loadPty: PtyRegistry['loadPty']
}

function createPtyAttachWiring({
  workspaceSandboxes,
  keptShells,
  injectSecrets,
  services,
  keptPlumbing,
  keptAttention,
  agentRunning,
  hibernatedPanes,
  portRequests,
  trackPty,
  feedPty,
  releaseMergedSandbox,
  restoreKeptAttention,
  windows,
  movingPanes,
  recoveryHeld,
  scratchFolders,
  artifactFolders,
  hostPaneGrants,
  paneLauncherDir,
  keepShellsOn,
  keptShellsProgram,
  withKeptProcess,
  keptPaneEnv,
  ptys,
  loadPty,
}: PtyAttachWiringDeps) {
  const { spawnSandboxed } = createSandboxSpawn({
    workspaceSandboxes,
    keptShells,
    injectSecrets,
    onSandboxSpawnFailure: () => services.onSandboxSpawnFailure,
  })

  const { reattachKept } = createKeptReattach({
    workspaceSandboxes,
    keptShells,
    keptPlumbing,
    keptAttention,
    agentRunning,
    hibernatedPanes,
    portRequests,
    trackPty,
    feedPty,
    releaseMergedSandbox,
    restoreKeptAttention,
    processes: () => services.processes,
    appLog: () => services.appLog,
  })

  const { subscriberFor, attachExisting } = createLiveAttach({ windows, movingPanes, recoveryHeld })

  const { planSpawn } = createSpawnPlanner({
    scratchFolders,
    artifactFolders,
    hostPaneGrants,
    workspaceSandboxes,
    readSettingsFile,
    paneLauncherDir,
    keepShellsOn,
    keptShellsProgram,
    telemetry: () => services.telemetry,
  })

  const { spawnKept } = createKeptSpawner({
    keptShells,
    keptPlumbing,
    withKeptProcess,
    keptPaneEnv,
    appLog: () => services.appLog,
  })

  const { startTracked } = createPtyStart({
    keptShells,
    workspaceSandboxes,
    hibernatedPanes,
    trackPty,
    feedPty,
    releaseMergedSandbox,
    telemetry: () => services.telemetry,
    appLog: () => services.appLog,
  })

  const { attachPty } = createPtyAttach({
    ptys,
    keptShells,
    loadPty,
    subscriberFor,
    attachExisting,
    reattachKept,
    planSpawn,
    spawnSandboxed,
    spawnKept,
    startTracked,
    telemetry: () => services.telemetry,
  })

  return { attachPty }
}
