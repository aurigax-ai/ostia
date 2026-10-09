export const UNATTENDED_QUIT_DEADLINE_MS = 5000

export type QuitPlan = 'proceed' | 'ask' | 'unattended'

export const QUIT_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const

export interface QuitState {
  approved: boolean
  requestedByOstia: boolean
  signaled: boolean
  platform: NodeJS.Platform
}

export function planQuit(state: QuitState): QuitPlan {
  if (state.approved) return 'proceed'
  if (state.signaled) return 'unattended'
  if (state.requestedByOstia || state.platform === 'darwin') return 'ask'
  return 'unattended'
}

export function exitAfterDeadline(
  exit: () => void,
  deadlineMs = UNATTENDED_QUIT_DEADLINE_MS,
): ReturnType<typeof setTimeout> {
  const timer = setTimeout(exit, deadlineMs)
  timer.unref?.()
  return timer
}

export function keptOnQuit(
  restart: boolean,
  panes: readonly { paneId: string; kept: boolean }[],
): string[] {
  return restart ? panes.filter((p) => p.kept).map((p) => p.paneId) : []
}

export type QuitLog = (event: string, fields: Record<string, string | number>) => void

export interface QuitTrace {
  stage: (name: string) => void
  current: () => string
  elapsedMs: () => number
}

export function createQuitTrace(log: QuitLog, now: () => number = Date.now): QuitTrace {
  let startedAt: number | null = null
  let stageAt = 0
  let name = 'idle'
  return {
    stage(next) {
      const at = now()
      if (startedAt === null) {
        startedAt = at
        stageAt = at
      }
      log('quit-stage', { stage: next, after: name, tookMs: at - stageAt, totalMs: at - startedAt })
      name = next
      stageAt = at
    },
    current: () => name,
    elapsedMs: () => (startedAt === null ? 0 : now() - startedAt),
  }
}

export function summarizeKinds(kinds: readonly string[]): string {
  const counts = new Map<string, number>()
  for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1)
  return [...counts]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([kind, count]) => `${kind}:${count}`)
    .join(',')
}
