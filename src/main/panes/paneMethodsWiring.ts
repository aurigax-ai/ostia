import { setTimeout as sleep } from 'node:timers/promises'
import { parseAgentHooks } from '../../shared/agents/agentHooks'
import { isResumableAgent } from '../../shared/agents/agentResume'
import type { ManagerSettings } from '../../shared/agents/managerSettings'
import type { CommandTarget } from '../../shared/control/commands'
import { statusLine } from '../../shared/panes/paneStatus'
import type { TerminalStateSnapshot } from '../../shared/terminal/ptyApi'
import type { AgentWiring } from '../agents/agentWiring'
import { readTail, transcriptPath } from '../agents/transcriptFiles'
import type { Reach } from '../approvals/reach'
import { targetOf } from '../attention/attention'
import type { CommandBridge } from '../control/commandBridge'
import { getByPaneId, type PaneIdentity, resolveExternal } from '../control/idRegistry'
import type { AgentJournal } from '../diagnostics/agentJournal'
import type { ExtensionHost } from '../extensions/extensionHost'
import { worktreeKey } from '../git/repo'
import { readSettingsFile } from '../platform/settingsFile'
import type { WorkspaceSandboxes } from '../sandbox/workspaceSandboxes'
import type { PtyIo } from '../terminal/pty/ptyIo'
import type { PtyEntry } from '../terminal/pty/ptyRegistry'
import type { KeptAttention } from '../tmux/keptAttention'
import type { WindowSend } from '../windows/windowSend'
import type { ScratchFolders } from '../workspaces/scratchFolders'
import { windowForWorkspace } from '../workspaces/workspaceRegistry'
import { registerExtensionWake } from './extensionWake'
import { createPaneConfirms } from './paneConfirm'
import { PaneEvents } from './paneEvents'
import { paneGit } from './paneGit'
import { type PaneAttentionPeek, registerPaneIoMethods } from './paneIo'
import type { PaneJournal } from './paneJournal'
import { listPanes } from './paneList'
import { registerPaneMoveToMethods } from './paneMoveTo'
import type { PaneReachDeps } from './paneReach'
import { collectStatus, type PaneStatusDeps, registerPaneStatusMethods } from './paneStatus'
import { registerPaneTranscriptMethods } from './paneTranscript'
import { type PaneWatch, registerPaneWaitMethods } from './paneWait'
import { wakeHibernatedPane } from './paneWake'
import type { PaneWaking } from './paneWaking'
import { registerPaneWatchMethods } from './paneWatchMethods'
import { WorktreeShare } from './worktreeShare'

interface PaneMethodsWiringDeps {
  keptAttention: KeptAttention
  execCommand: CommandBridge['execCommand']
  registry: AgentWiring['registry']
  reach: Reach
  workspaceSandboxes: WorkspaceSandboxes
  ptys: Map<string, PtyEntry>
  paneIo: PtyIo['paneIo']
  getTerminalState: CommandBridge['getTerminalState']
  managerSettings: () => ManagerSettings
  ptyPid: (paneId: string) => number | undefined
  windowIds: WindowSend['windowIds']
  isWaking: (paneId: string) => boolean
  paneWaking: PaneWaking
  services: {
    extensionHost: ExtensionHost | null
    agentJournal: AgentJournal | null
  }
  scratchFolders: ScratchFolders
  workspaceCommandTarget: (workspaceId: string) => CommandTarget
  paneWatch: PaneWatch
  paneJournal: PaneJournal
  remoteCwdOfPane: (paneId: string) => unknown
  terminalState: Map<string, TerminalStateSnapshot>
}

export type PaneMethodsWiring = ReturnType<typeof registerPaneMethodsWiring>

export function registerPaneMethodsWiring({
  keptAttention,
  execCommand,
  registry,
  reach,
  workspaceSandboxes,
  ptys,
  paneIo,
  getTerminalState,
  managerSettings,
  ptyPid,
  windowIds,
  isWaking,
  paneWaking,
  services,
  scratchFolders,
  workspaceCommandTarget,
  paneWatch,
  paneJournal,
  remoteCwdOfPane,
  terminalState,
}: PaneMethodsWiringDeps) {
  const peekAttention = async (to: PaneIdentity): Promise<PaneAttentionPeek> => {
    const unreported = keptAttention.peek(to.paneId)
    if (unreported) return unreported
    const res = await execCommand(targetOf(to), 'attention.peek')
    return res.ok && res.result && typeof res.result === 'object' ? res.result : {}
  }
  const paneHibernated = async (to: PaneIdentity): Promise<boolean> => {
    const res = await execCommand(targetOf(to), 'pane.hibernated')
    return res.ok && (res.result as { hibernated?: unknown } | undefined)?.hibernated === true
  }
  const paneExited = (paneId: string): boolean => {
    const entry = registry.forPane(paneId)
    if (entry) return entry.status === 'exited'
    return terminalState.get(paneId)?.running === false
  }
  const paneReachDeps: PaneReachDeps = {
    processPane: async (ref, ctx) =>
      registry
        .livePanes(ref, ctx.identity.workspaceId, await reach.visible(ctx))
        .map((entry) => entry.paneId),
    visible: reach.visible,
    inScope: reach.inScope,
    isChild: (ownerPaneId, paneId) => registry.isChild(ownerPaneId, paneId),
    isSandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId),
    isConfined: (paneId) => ptys.get(paneId)?.sandboxed === true,
  }
  const confirmDeps = {
    io: paneIo,
    attention: peekAttention,
    panes: () => listPanes({ execCommand, getTerminalState, ptyPid, windowIds, waking: isWaking }),
    delay: (ms: number) => sleep(ms),
    hooksOn: (agent: string) =>
      isResumableAgent(agent) && parseAgentHooks(readSettingsFile().agents?.hooks)[agent],
  }
  registerPaneIoMethods({
    ...paneReachDeps,
    ...confirmDeps,
    state: getTerminalState,
    managerAllowsInput: () => managerSettings().allowInput,
    inputSent: (to) => void execCommand(targetOf(to), 'attention.typed'),
    hibernated: paneHibernated,
    wake: (to) => wakeHibernatedPane(execCommand, to),
    hibernate: (to) => execCommand(targetOf(to), 'pane.hibernate'),
    waking: paneWaking,
    close: (to) => execCommand(targetOf(to), 'pane.close'),
    resume: (to) => execCommand(targetOf(to), 'agent.resume'),
    journal: services.agentJournal ?? undefined,
  })
  registerExtensionWake({
    openedBy: (caller, paneId) => services.extensionHost?.openedBy(caller, paneId) ?? false,
    hibernated: paneHibernated,
    wake: (to) => wakeHibernatedPane(execCommand, to),
    panes: () => listPanes({ execCommand, getTerminalState, ptyPid, windowIds, waking: isWaking }),
    waking: paneWaking,
  })
  registerPaneMoveToMethods({
    ...paneReachDeps,
    ownerWindow: windowForWorkspace,
    paneOf: getByPaneId,
    isScratch: (workspaceId) => scratchFolders.isScratch(workspaceId),
    ensureReach: reach.ensure,
    move: (to, workspaceId) => execCommand(targetOf(to), 'pane.moveToWorkspace', { workspaceId }),
    tabPlan: (workspaceId, paneIds, tab) =>
      execCommand(workspaceCommandTarget(workspaceId), 'pane.tabPlan', { paneIds, tab }, true),
    joinTab: (workspaceId, paneIds, tab) =>
      execCommand(workspaceCommandTarget(workspaceId), 'pane.joinTab', { paneIds, tab }, true),
    panes: () => listPanes({ execCommand, getTerminalState, ptyPid, windowIds, waking: isWaking }),
  })
  const listAll = () =>
    listPanes({ execCommand, getTerminalState, ptyPid, windowIds, waking: isWaking })
  const worktreeShare = new WorktreeShare({
    panes: listAll,
    key: worktreeKey,
    identity: (externalId) => {
      const found = resolveExternal(externalId)
      return found?.kind === 'pane' ? found : undefined
    },
    remote: (paneId) => remoteCwdOfPane(paneId) !== undefined,
  })
  const lastCwd = new Map<string, string | undefined>()
  paneWatch.tap((paneId, change) => {
    if (change.kind === 'closed') lastCwd.delete(paneId)
    if (change.kind === 'state') {
      const cwd = terminalState.get(paneId)?.cwd
      if (lastCwd.get(paneId) === cwd) return
      lastCwd.set(paneId, cwd)
    }
    worktreeShare.schedule()
  })
  const statusDeps: PaneStatusDeps = {
    ...paneReachDeps,
    panes: listAll,
    journal: paneJournal,
    wakingSince: (paneId) => paneWaking.since(paneId),
    conflicts: (externalId) => worktreeShare.others(externalId),
    exited: paneExited,
    git: paneGit({
      isRemote: (paneId) => remoteCwdOfPane(paneId) !== undefined,
      isSandboxed: (paneId) => {
        const workspaceId = resolveExternal(paneId)?.workspaceId
        return workspaceId === undefined || workspaceSandboxes.isEnabled(workspaceId)
      },
    }),
    now: Date.now,
  }
  const statusOfPane = async (to: PaneIdentity, callerExternalId: string) =>
    collectStatus(statusDeps, to, callerExternalId, await listAll())
  registerPaneWaitMethods({
    ...paneReachDeps,
    watch: paneWatch,
    attention: peekAttention,
    exited: paneExited,
    terminal: (paneId) => terminalState.get(paneId),
    status: statusOfPane,
  })
  registerPaneStatusMethods(statusDeps)

  const paneEvents = new PaneEvents({
    identity: getByPaneId,
    exited: paneExited,
    line: async (watched, subscriber) => {
      const status = await statusOfPane(watched, subscriber.externalId)
      return status ? statusLine(status) : undefined
    },
  })
  paneJournal.subscribe(paneEvents.onJournal)
  paneWatch.tap(paneEvents.onChange)
  registerPaneWatchMethods(paneReachDeps)

  registerPaneTranscriptMethods({
    ...paneReachDeps,
    panes: () => listPanes({ execCommand, getTerminalState, ptyPid, windowIds, waking: isWaking }),
    lines: async (resume, bytes) => {
      const path = transcriptPath(resume)
      if (!path) return null
      return readTail(path, bytes).catch(() => null)
    },
  })

  return { paneReachDeps, turnConfirms: createPaneConfirms(confirmDeps) }
}
