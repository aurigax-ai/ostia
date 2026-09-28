import type { PaneNode } from '../layout/types'
import type { PaneAttention } from './attention'

export function latestUnreadMessage(
  panes: readonly PaneNode[],
  byPane: Readonly<Record<string, PaneAttention | undefined>>,
): string | null {
  let best: PaneAttention | undefined
  for (const pane of panes) {
    const a = byPane[pane.id]
    if (a?.unread && a.message && (!best || a.at > best.at)) best = a
  }
  return best?.message ?? null
}

export function runningTitle(
  panes: readonly PaneNode[],
  activePaneId: string | undefined,
  running: Readonly<Record<string, string | undefined>>,
): string | null {
  const live = panes.filter((p) => p.kind === 'terminal' && running[p.id] !== undefined)
  const pick = live.find((p) => p.id === activePaneId) ?? live[0]
  return pick?.title ?? null
}
