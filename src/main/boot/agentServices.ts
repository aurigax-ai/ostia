import { ChangeSignal } from '../../shared/common/actThenConfirm'
import { AgentRunningPanes } from '../agents/agentRunning'
import { ReportedAgentWork } from '../agents/agentWork'
import type { OriginReach } from '../agents/originAgents'
import { approvals } from '../approvals/approvals'
import { createAskHub } from '../approvals/asks'
import { questions } from '../approvals/questions'
import { targetOf } from '../attention/attention'
import { emitPlatformEvent } from '../control/events'
import { type PaneIdentity, getByPaneId } from '../control/idRegistry'
import { PaneAttentionEvents } from '../extensions/paneAttentionEvents'
import { PaneLifecycleEvents } from '../extensions/paneLifecycleEvents'
import { PaneWatch } from '../panes/paneWait'
import { PaneWaking } from '../panes/paneWaking'
import type { SavedAttention } from '../tmux/attentionFile'
import { KeptAttention } from '../tmux/keptAttention'
import type { WorkspaceContext } from './workspaceServices'

export function createAgentServices(ctx: WorkspaceContext) {
  const { emitPaneEvent, execCommand, mainStrings, services } = ctx

  const agentChanges = new ChangeSignal()
  const startedAgents = new Set<string>()
  const agentRunning = new AgentRunningPanes(() => {
    services.broker?.persist()
    agentChanges.fire()
  })
  const agentWork = new ReportedAgentWork()

  const askHub = createAskHub({
    text: () => mainStrings().approvals,
    questions,
    approvals,
    identity: getByPaneId,
    created: (ask) => emitPlatformEvent('ask.created', { ask }),
    resolved: (resolved) => emitPlatformEvent('ask.resolved', resolved),
  })
  const keptAttention = new KeptAttention()

  function restoreKeptAttention(identity: PaneIdentity, saved: SavedAttention): void {
    void execCommand(targetOf(identity), 'attention.set', saved).then((res) => {
      if (res.ok) keptAttention.reported(identity.paneId)
    })
  }
  const paneWatch = new PaneWatch()
  const paneAttentionEvents = new PaneAttentionEvents({
    identity: getByPaneId,
    emit: (payload) => emitPaneEvent('pane.attention', payload),
  })
  const paneLifecycleEvents = new PaneLifecycleEvents({
    identity: getByPaneId,
    emit: (payload) => emitPaneEvent('pane.lifecycle', payload),
  })
  const paneWaking = new PaneWaking()
  const paneStartErrors = new Map<string, string>()
  const isWaking = (paneId: string): boolean => paneWaking.has(paneId)
  const reachesPane: OriginReach = (senderWindowId, sourcePaneId, targetPaneId) =>
    services.broker?.reaches(senderWindowId, sourcePaneId, targetPaneId) ?? false

  return {
    agentChanges,
    startedAgents,
    agentRunning,
    agentWork,
    askHub,
    keptAttention,
    restoreKeptAttention,
    paneWatch,
    paneAttentionEvents,
    paneLifecycleEvents,
    paneWaking,
    paneStartErrors,
    isWaking,
    reachesPane,
  }
}

export type AgentContext = WorkspaceContext & ReturnType<typeof createAgentServices>
