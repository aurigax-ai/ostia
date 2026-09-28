import { paneIds } from '../layout/tree'
import { useBlocksStore } from '../stores/blocksStore'
import { useLayoutStore } from '../stores/layoutStore'
import { type SessionState, useSessionsStore } from '../stores/sessionsStore'

export const NOTIFY_AFTER_MS = 10_000

export function aggregateSessionState(current: SessionState, anyRunning: boolean): SessionState {
  if (anyRunning) return 'working'
  return current === 'working' ? 'idle' : current
}

export function shouldNotifyCommandEnd(durationMs: number, windowFocused: boolean): boolean {
  return !windowFocused && durationMs >= NOTIFY_AFTER_MS
}

export function syncSessionState(sessionId: string): void {
  const sessions = useSessionsStore.getState()
  const session = sessions.sessions.find((s) => s.id === sessionId)
  if (!session) return
  const layout = useLayoutStore.getState().bySession[sessionId]
  const running = useBlocksStore.getState().running
  const anyRunning = layout ? paneIds(layout.root).some((id) => running[id] !== undefined) : false
  sessions.setState(sessionId, aggregateSessionState(session.state, anyRunning))
}
