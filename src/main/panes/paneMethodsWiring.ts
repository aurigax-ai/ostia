import { setTimeout as sleep } from 'node:timers/promises'
import { parseAgentHooks } from '../../shared/agents/agentHooks'
import { isResumableAgent } from '../../shared/agents/agentResume'
import type { ManagerSettings } from '../../shared/agents/managerSettings'
import type { CommandTarget } from '../../shared/control/commands'
import type { TerminalStateSnapshot } from '../../shared/terminal/ptyApi'
import type { AgentWiring } from '../agents/agentWiring'
import type { Reach } from '../approvals/reach'
import { targetOf } from '../attention/attention'
import type { CommandBridge } from '../control/commandBridge'
import { type PaneIdentity, getByPaneId } from '../control/idRegistry'
import type { ExtensionHost } from '../extensions/extensionHost'
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
import { type PaneAttentionPeek, registerPaneIoMethods } from './paneIo'
import { listPanes } from './paneList'
import { registerPaneMoveToMethods } from './paneMoveTo'
import type { PaneReachDeps } from './paneReach'
import { type PaneWatch, registerPaneWaitMethods } from './paneWait'
import { wakeHibernatedPane } from './paneWake'
import type { PaneWaking } from './paneWaking'

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
  }
  scratchFolders: ScratchFolders
  workspaceCommandTarget: (workspaceId: string) => CommandTarget
  paneWatch: PaneWatch
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
  const paneReachDeps: PaneReachDeps = {
    processPane: async (ref, ctx) => {
      const entry = registry.resolve(ref, ctx.identity.workspaceId, await reach.visible(ctx))
      return entry && entry.status !== 'closed' ? entry.paneId : undefined
    },
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
  registerPaneWaitMethods({
    ...paneReachDeps,
    watch: paneWatch,
    attention: peekAttention,
    exited: (paneId) => {
      const entry = registry.forPane(paneId)
      if (entry) return entry.status === 'exited'
      return terminalState.get(paneId)?.running === false
    },
  })

  return { paneHibernated, turnConfirms: createPaneConfirms(confirmDeps) }
}
