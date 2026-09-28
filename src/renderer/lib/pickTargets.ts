import type { AttentionState } from '@shared/types'
import { allPanes } from '../layout/tree'
import type { LayoutNode } from '../layout/types'
import type { PaneAttention } from './attention'

export interface PickTarget {
  paneId: string
  sessionId: string
  sessionName: string
  title: string
  cwd?: string
  state: AttentionState
  sameSession: boolean
}

export interface PickTargetInput {
  sessions: readonly { id: string; name: string }[]
  layouts: Readonly<Record<string, { root: LayoutNode }>>
  sourceSessionId: string
  attention: Readonly<Record<string, PaneAttention>>
  touchedAt: Readonly<Record<string, number>>
}

export function pickTargets(input: PickTargetInput): PickTarget[] {
  const out: PickTarget[] = []
  for (const session of input.sessions) {
    const layout = input.layouts[session.id]
    if (!layout) continue
    for (const pane of allPanes(layout.root)) {
      if (pane.kind !== 'terminal' && pane.kind !== 'agent') continue
      out.push({
        paneId: pane.id,
        sessionId: session.id,
        sessionName: session.name,
        title: pane.title,
        cwd: pane.cwd,
        state: input.attention[pane.id]?.state ?? 'none',
        sameSession: session.id === input.sourceSessionId,
      })
    }
  }
  const recency = (id: string): number => input.touchedAt[id] ?? 0
  return out.sort((a, b) => {
    if (a.sameSession !== b.sameSession) return a.sameSession ? -1 : 1
    return recency(b.paneId) - recency(a.paneId)
  })
}
