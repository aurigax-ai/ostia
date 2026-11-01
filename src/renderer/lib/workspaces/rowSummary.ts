import type { WorkspaceLiveState } from '@shared/attention/attention'
import type { PaneNode } from '@/lib/layout/types'

export type RowMark = 'working' | 'waiting' | 'error' | 'done'

type FactTone = 'waiting' | 'error' | 'plain' | 'muted'

export interface RowFact {
  text: string
  tone: FactTone
}

export function rowMark(state: WorkspaceLiveState): RowMark | null {
  return state === 'idle' ? null : state
}

export function liveTerminalCount(panes: readonly PaneNode[]): number {
  return panes.filter((p) => (p.kind === 'terminal' || p.kind === 'agent') && !p.hibernated).length
}

export function rowFact(input: {
  state: WorkspaceLiveState
  message: string | null
  offline: string | null
  running: string | null
}): RowFact | null {
  if (input.message) {
    const tone: FactTone =
      input.state === 'waiting' ? 'waiting' : input.state === 'error' ? 'error' : 'plain'
    return { text: input.message, tone }
  }
  if (input.offline) return { text: input.offline, tone: 'muted' }
  if (input.running) return { text: input.running, tone: 'muted' }
  return null
}

export interface StateCounts {
  waiting: number
  error: number
  working: number
}

export function stateCounts(states: readonly WorkspaceLiveState[]): StateCounts {
  const counts: StateCounts = { waiting: 0, error: 0, working: 0 }
  for (const s of states) {
    if (s === 'working' || s === 'waiting' || s === 'error') counts[s] += 1
  }
  return counts
}
