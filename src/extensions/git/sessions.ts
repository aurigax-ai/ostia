import type { PaneInfo, SessionInfo } from '../sdk'
import { expandHome } from '../sdk'

export class SessionCwds {
  private lastTerminal = new Map<string, string>()

  resolve(sessions: SessionInfo[], panes: PaneInfo[]): Map<string, string> {
    const out = new Map<string, string>()
    const live = new Set(sessions.map((s) => s.sessionId))
    for (const id of [...this.lastTerminal.keys()]) if (!live.has(id)) this.lastTerminal.delete(id)
    for (const session of sessions) {
      const own = panes.filter((p) => p.sessionId === session.sessionId)
      const active = own.find((p) => p.paneId === session.activePaneId)
      if (active?.kind === 'terminal' && active.cwd) {
        this.lastTerminal.set(session.sessionId, active.cwd)
      }
      const cwd =
        active?.cwd ||
        this.lastTerminal.get(session.sessionId) ||
        own.find((p) => p.kind === 'terminal' && p.cwd)?.cwd ||
        session.workDir
      if (cwd) out.set(session.sessionId, expandHome(cwd))
    }
    return out
  }
}
