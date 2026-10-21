import { type AgentLeftDeps, agentLeft } from '../agents/agentLeft'
import { createManagerPty } from '../manager/managerPty'
import { createPtyWiring } from '../terminal/pty/ptyWiring'
import type { AgentContext } from './agentServices'

export function createPaneServices(ctx: AgentContext) {
  const {
    agentRunning,
    agentWork,
    artifactFolders,
    closedPanes,
    hibernatedPanes,
    hostPaneGrants,
    injectSecrets,
    keepShellsOn,
    keptAttention,
    keptPaneEnv,
    keptPlumbing,
    keptShells,
    keptShellsProgram,
    mainStrings,
    movingPanes,
    openWaits,
    paneLauncherDir,
    paneWaking,
    paneLifecycleEvents,
    portRequests,
    primaryWindowId,
    ptys,
    recoveryHeld,
    releaseMergedSandbox,
    restoreKeptAttention,
    scratchFolders,
    services,
    startedAgents,
    terminalState,
    windows,
    withKeptProcess,
    workspaceSandboxes,
  } = ctx

  const {
    loadPty,
    feedPty,
    trackPty,
    killPty,
    hibernatePty,
    paneActivity,
    foregroundProgram,
    agentCwd,
    sandboxReadRules,
    ptyPid,
    paneOutput,
    paneIo,
    releasePtyFlow,
    hidePtyFlow,
    attachMirror,
    ptyWrite,
    attachPhoneObserver,
    windowOfPane,
    startRecovery,
    finishRecovery,
    releaseWindowPtys,
    holdPtys,
    releaseMovingPane,
    attachPty,
  } = createPtyWiring({
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
    bannerText: () => mainStrings().native.paneBanner,
  })

  const leftDeps: AgentLeftDeps = {
    running: (id) => agentRunning.has(id),
    waking: (id) => paneWaking.has(id),
    owner: (id) => {
      const entry = ptys.get(id)
      return entry
        ? { foreground: entry.pty.process, shell: entry.shell, sandboxed: entry.sandboxed }
        : undefined
    },
    recheck: (id, again) => ptys.get(id)?.kept?.afterForeground(again),
  }
  agentRunning.whenStopped((id) => agentLeft(leftDeps, id))
  paneWaking.subscribe((id, how) => {
    if (how === 'failed' && !hibernatedPanes.has(id)) agentLeft(leftDeps, id)
  })

  const { spawnManagerPty } = createManagerPty({ loadPty, primaryWindowId, trackPty, feedPty })

  return {
    killPty,
    hibernatePty,
    paneActivity,
    foregroundProgram,
    agentCwd,
    sandboxReadRules,
    ptyPid,
    paneOutput,
    paneIo,
    releasePtyFlow,
    hidePtyFlow,
    attachMirror,
    ptyWrite,
    attachPhoneObserver,
    windowOfPane,
    startRecovery,
    finishRecovery,
    releaseWindowPtys,
    holdPtys,
    releaseMovingPane,
    attachPty,
    spawnManagerPty,
  }
}

export type PaneContext = AgentContext & ReturnType<typeof createPaneServices>
