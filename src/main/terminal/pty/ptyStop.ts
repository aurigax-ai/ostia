import type { TerminalStateSnapshot } from '../../../shared/terminal/ptyApi'
import type { ReportedAgentWork } from '../../agents/agentWork'
import type { AppLog } from '../../diagnostics/appLog'
import type { Telemetry } from '../../diagnostics/telemetry'
import type { PaneLifecycleEvents } from '../../extensions/paneLifecycleEvents'
import { dropName } from '../../panes/paneNames'
import type { PaneWaking } from '../../panes/paneWaking'
import type { KeptShells } from '../../tmux/keptShells'
import { stashScrollback } from '../../workspaces/savedScrollback'
import type { ReapReason } from '../ptyReaper'
import { releaseAgentDir } from '../shellIntegration'
import { type PtyEntry, removeStateFile } from './ptyRegistry'

interface PtyStopDeps {
  ptys: Map<string, PtyEntry>
  recoveryHeld: Set<string>
  closedPanes: Set<string>
  hibernatedPanes: Set<string>
  startedAgents: Set<string>
  terminalState: Map<string, TerminalStateSnapshot>
  keptShells: KeptShells
  agentWork: ReportedAgentWork
  paneWaking: PaneWaking
  paneLifecycleEvents: PaneLifecycleEvents
  telemetry: () => Telemetry | null
  appLog: () => AppLog | null
}

export type PtyStop = ReturnType<typeof createPtyStop>

export function createPtyStop({
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
  telemetry,
  appLog,
}: PtyStopDeps) {
  function killPty(paneId: string, reason: ReapReason): void {
    const entry = ptys.get(paneId)
    if (!entry) return
    appLog()?.info('pty-reap', { pane: paneId, reason })
    recoveryHeld.delete(paneId)
    closedPanes.delete(paneId)
    startedAgents.delete(paneId)
    if (entry.killTimer) clearTimeout(entry.killTimer)
    try {
      entry.pty.kill()
    } catch {}
    entry.flow.dispose()
    entry.mirror.dispose()
    removeStateFile(entry)
    keptShells.removeToken(paneId)
    ptys.delete(paneId)
    releaseAgentDir(paneId)
    agentWork.clear(paneId)
    if (reason !== 'hibernated') dropName(paneId)
  }

  function hibernatePty(paneId: string): boolean {
    const entry = ptys.get(paneId)
    if (!entry) return false
    telemetry()?.count('agents', 'hibernation')
    stashScrollback(paneId, entry.mirror.serialize())
    hibernatedPanes.add(paneId)
    paneWaking.end(paneId, 'failed')
    entry.subs.clear()
    killPty(paneId, 'hibernated')
    terminalState.delete(paneId)
    paneLifecycleEvents.change(paneId, 'hibernated')
    return true
  }

  return { killPty, hibernatePty }
}
