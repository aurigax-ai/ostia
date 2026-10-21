import type { BrowserWindow } from 'electron'
import type { TerminalStateSnapshot } from '../../../shared/terminal/ptyApi'
import type { AgentRunningPanes } from '../../agents/agentRunning'
import type { ReportedAgentWork } from '../../agents/agentWork'
import type { ArtifactFolders } from '../../artifacts/artifactFolders'
import type { PaneIdentity } from '../../control/idRegistry'
import type { AppLog } from '../../diagnostics/appLog'
import type { Telemetry } from '../../diagnostics/telemetry'
import type { PaneLifecycleEvents } from '../../extensions/paneLifecycleEvents'
import type { OpenWaits } from '../../files/openWaits'
import type { PaneWaking } from '../../panes/paneWaking'
import type { ProcessRegistry } from '../../panes/processRegistry'
import { foregroundCwd } from '../../platform/foregroundCwd'
import { readSettingsFile } from '../../platform/settingsFile'
import type { HostPaneGrants } from '../../sandbox/hostPanes'
import type { PortRequests } from '../../sandbox/ports/portRequests'
import type { WorkspaceSandboxes } from '../../sandbox/workspaceSandboxes'
import type { SavedAttention } from '../../tmux/attentionFile'
import type { KeptAttention } from '../../tmux/keptAttention'
import { createKeptReattach } from '../../tmux/keptReattach'
import type { KeptShellsWiring } from '../../tmux/keptShellsWiring'
import { createKeptSpawner } from '../../tmux/keptSpawn'
import type { ScratchFolders } from '../../workspaces/scratchFolders'
import type { WorkspaceLifecycle } from '../../workspaces/workspaceLifecycle'
import type { PaneHistories } from '../history/paneHistories'
import type { PaneBannerText } from '../paneBanner'
import { createPtyAttach } from './ptyAttach'
import { createPtyIo } from './ptyIo'
import { createLiveAttach } from './ptyLiveAttach'
import { createPtyQueries } from './ptyQueries'
import { createPtyRecovery } from './ptyRecovery'
import type { PtyRegistry } from './ptyRegistry'
import { createPtyRegistry, type PtyEntry } from './ptyRegistry'
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
  paneLifecycleEvents: PaneLifecycleEvents
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
  bannerText: () => PaneBannerText
}

type PtyCoreDeps = Pick<
  PtyWiringDeps,
  | 'ptys'
  | 'movingPanes'
  | 'recoveryHeld'
  | 'closedPanes'
  | 'openWaits'
  | 'agentRunning'
  | 'agentWork'
  | 'keptAttention'
  | 'services'
  | 'hibernatedPanes'
  | 'startedAgents'
  | 'terminalState'
  | 'keptShells'
  | 'paneWaking'
  | 'paneLifecycleEvents'
  | 'workspaceSandboxes'
>

function createPtyCore({
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
  paneLifecycleEvents,
  workspaceSandboxes,
}: PtyCoreDeps) {
  const registry = createPtyRegistry({
    ptys,
    movingPanes,
    recoveryHeld,
    closedPanes,
    scheduleReap: (paneId, entry) => recovery.scheduleReap(paneId, entry),
    openWaits,
    agentRunning,
    agentWork,
    keptAttention,
    processes: () => services.processes,
    appLog: () => services.appLog,
    histories: () => services.histories,
  })

  const stop = createPtyStop({
    ptys,
    recoveryHeld,
    closedPanes,
    hibernatedPanes,
    startedAgents,
    terminalState,
    keptShells,
    agentWork,
    paneWaking,
    paneLifecycleEvents,
    telemetry: () => services.telemetry,
    appLog: () => services.appLog,
  })

  const queries = createPtyQueries({ ptys, agentRunning, workspaceSandboxes, foregroundCwd })
  const io = createPtyIo({ ptys })
  const recovery = createPtyRecovery({
    ptys,
    movingPanes,
    recoveryHeld,
    closedPanes,
    killPty: stop.killPty,
    appLog: () => services.appLog,
  })

  return { ...registry, ...stop, ...queries, ...io, ...recovery }
}

export function createPtyWiring(deps: PtyWiringDeps) {
  const core = createPtyCore(deps)
  const { attachPty } = createPtyAttachWiring({ ...deps, ...core })

  return { ...core, attachPty }
}

type PtyAttachWiringDeps = PtyWiringDeps & Pick<PtyRegistry, 'trackPty' | 'feedPty' | 'loadPty'>

function createPtyAttachWiring({
  workspaceSandboxes,
  keptShells,
  injectSecrets,
  services,
  keptPlumbing,
  keptAttention,
  agentRunning,
  hibernatedPanes,
  paneLifecycleEvents,
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
  bannerText,
  ptys,
  loadPty,
}: PtyAttachWiringDeps) {
  const { spawnSandboxed } = createSandboxSpawn({
    workspaceSandboxes,
    keptShells,
    injectSecrets,
    onSandboxSpawnFailure: () => services.onSandboxSpawnFailure,
    bannerText,
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
    bannerText,
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
    bannerText,
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
    paneLifecycleEvents,
    trackPty,
    feedPty,
    releaseMergedSandbox,
    telemetry: () => services.telemetry,
    appLog: () => services.appLog,
    bannerText,
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
    historySettled: (paneId) => services.histories?.settled(paneId) ?? Promise.resolve(),
    telemetry: () => services.telemetry,
    bannerText,
  })

  return { attachPty }
}
