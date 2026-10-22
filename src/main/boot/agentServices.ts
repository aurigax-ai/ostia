import { ChangeSignal } from '../../shared/common/actThenConfirm'
import { AgentResumes } from '../agents/agentResumes'
import { AgentRunningPanes } from '../agents/agentRunning'
import { ReportedAgentWork } from '../agents/agentWork'
import { createClaudeAccounts } from '../agents/claudeAccounts/claudeAccountsWiring'
import type { OriginReach } from '../agents/originAgents'
import { approvals } from '../approvals/approvals'
import { createAskHub } from '../approvals/asks'
import { questions } from '../approvals/questions'
import { targetOf } from '../attention/attention'
import { emitPlatformEvent } from '../control/events'
import { getByPaneId, type PaneIdentity } from '../control/idRegistry'
import { PaneAttentionEvents } from '../extensions/paneAttentionEvents'
import { PaneLifecycleEvents } from '../extensions/paneLifecycleEvents'
import { PaneJournal } from '../panes/paneJournal'
import { PaneTurns } from '../panes/paneTurns'
import { PaneWatch } from '../panes/paneWait'
import { PaneWaking } from '../panes/paneWaking'
import type { SavedAttention } from '../tmux/attentionFile'
import { KeptAttention } from '../tmux/keptAttention'
import type { WorkspaceContext } from './workspaceServices'

export function createAgentServices(ctx: WorkspaceContext) {
  const {
    broadcast,
    emitPaneEvent,
    execCommand,
    mainStrings,
    openExternalSafe,
    openTerminalInWindow,
    services,
    terminalState,
  } = ctx

  const agentChanges = new ChangeSignal()
  const agentResumes = new AgentResumes()
  const startedAgents = new Set<string>()
  const agentRunning = new AgentRunningPanes(() => {
    services.broker?.persist()
    agentChanges.fire()
  })
  const claudeAccounts = createClaudeAccounts({
    openTerminalInWindow,
    openExternalSafe,
    mainStrings,
    broadcast,
    agentRunning,
  })
  const agentWork = new ReportedAgentWork()
  const paneTurns = new PaneTurns()

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
  const paneJournal = new PaneJournal({
    terminal: (paneId) => terminalState.get(paneId),
    now: Date.now,
  })
  paneWatch.tap(paneJournal.onChange)
  const paneAttentionEvents = new PaneAttentionEvents({
    identity: getByPaneId,
    emit: (payload) => emitPaneEvent('pane.attention', payload),
  })
  const paneLifecycleEvents = new PaneLifecycleEvents({
    identity: getByPaneId,
    emit: (payload) => emitPaneEvent('pane.lifecycle', payload),
    noted: (paneId) => paneJournal.lifecycle(paneId),
  })
  const paneWaking = new PaneWaking()
  const paneStartErrors = new Map<string, string>()
  const isWaking = (paneId: string): boolean => paneWaking.has(paneId)
  const reachesPane: OriginReach = (senderWindowId, sourcePaneId, targetPaneId) =>
    services.broker?.reaches(senderWindowId, sourcePaneId, targetPaneId) ?? false

  return {
    agentChanges,
    agentResumes,
    claudeAccounts,
    startedAgents,
    agentRunning,
    agentWork,
    paneTurns,
    askHub,
    keptAttention,
    restoreKeptAttention,
    paneWatch,
    paneJournal,
    paneAttentionEvents,
    paneLifecycleEvents,
    paneWaking,
    paneStartErrors,
    isWaking,
    reachesPane,
  }
}

export type AgentContext = WorkspaceContext & ReturnType<typeof createAgentServices>
