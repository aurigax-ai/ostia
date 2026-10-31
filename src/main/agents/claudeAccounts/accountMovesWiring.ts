import { targetOf } from '../../attention/attention'
import type { CommandBridge } from '../../control/commandBridge'
import { getByPaneId, resolveExternal } from '../../control/idRegistry'
import type { PaneJournal } from '../../panes/paneJournal'
import { listPanes, type PaneListDeps } from '../../panes/paneList'
import type { PaneWatch } from '../../panes/paneWait'
import { wakeHibernatedPane } from '../../panes/paneWake'
import type { PaneWaking } from '../../panes/paneWaking'
import type { WorkspaceSandboxes } from '../../sandbox/workspaceSandboxes'
import type { PtyEntry } from '../../terminal/pty/ptyRegistry'
import type { ScratchFolders } from '../../workspaces/scratchFolders'
import { backgroundWork, type ReportedAgentWork, readProcessTable } from '../agentWork'
import { AccountMoves, type MovePane } from './accountMoves'
import type { ClaudeAccounts } from './claudeAccounts'

const SESSION_STAYS_CHANNEL = 'claude-accounts:session-stays'

interface AccountMovesWiringDeps {
  claudeAccounts: Pick<ClaudeAccounts, 'current' | 'accountOfPane'>
  execCommand: CommandBridge['execCommand']
  getTerminalState: PaneListDeps['getTerminalState']
  ptyPid: PaneListDeps['ptyPid']
  windowIds: PaneListDeps['windowIds']
  isWaking: PaneListDeps['waking']
  ptys: Map<string, PtyEntry>
  agentWork: ReportedAgentWork
  paneJournal: PaneJournal
  paneWatch: PaneWatch
  paneWaking: PaneWaking
  workspaceSandboxes: Pick<WorkspaceSandboxes, 'isEnabled'>
  scratchFolders: Pick<ScratchFolders, 'isScratch'>
  sendToWindow: (windowId: string, channel: string, payload: unknown) => void
}

export function createAccountMoves(deps: AccountMovesWiringDeps): AccountMoves {
  const { execCommand, ptys } = deps

  const panes = async (): Promise<MovePane[]> => {
    const listed = await listPanes({ ...deps, waking: deps.isWaking })
    return listed.flatMap((entry) => {
      const to = resolveExternal(entry.paneId)
      if (to?.kind !== 'pane') return []
      return [
        {
          paneId: to.paneId,
          agent: entry.agent,
          session: entry.agentSessionId,
          hibernated: entry.hibernated === true,
          waking: entry.waking === true,
        },
      ]
    })
  }

  const moves = new AccountMoves({
    current: () => deps.claudeAccounts.current(),
    accountOf: (paneId) => deps.claudeAccounts.accountOfPane(paneId),
    panes,
    isolated: (paneId) => {
      const to = getByPaneId(paneId)
      return (
        !to ||
        to.manager === true ||
        deps.workspaceSandboxes.isEnabled(to.workspaceId) ||
        deps.scratchFolders.isScratch(to.workspaceId)
      )
    },
    turnState: (paneId) => deps.paneJournal.stateOf(paneId),
    busy: async (paneId) => {
      const entry = ptys.get(paneId)
      if (!entry) return 'unknown'
      return backgroundWork(deps.agentWork.reason(paneId), await readProcessTable(), entry.pty.pid)
    },
    drafting: (paneId) => ptys.get(paneId)?.input.drafting() ?? false,
    inputCount: (paneId) => ptys.get(paneId)?.input.writes,
    hibernate: async (paneId) => {
      const to = getByPaneId(paneId)
      if (!to) return 'no-terminal'
      const res = await execCommand(targetOf(to), 'pane.hibernate', undefined, true)
      const outcome = res.ok ? (res.result as { outcome?: unknown } | undefined)?.outcome : null
      return typeof outcome === 'string' ? outcome : 'no-terminal'
    },
    wake: async (paneId) => {
      const to = getByPaneId(paneId)
      return to ? (await wakeHibernatedPane(execCommand, to)).woke : false
    },
    waking: deps.paneWaking,
    stays: (paneId) => {
      const to = getByPaneId(paneId)
      if (to) deps.sendToWindow(to.windowId, SESSION_STAYS_CHANNEL, paneId)
    },
  })

  deps.paneJournal.subscribe((paneId, event) => {
    if (event.kind === 'state') void moves.idle(paneId)
  })
  deps.paneWaking.subscribe((paneId) => void moves.idle(paneId))
  deps.paneWatch.tap((paneId, change) => {
    if (change.kind === 'closed') moves.closed(paneId)
  })
  return moves
}
