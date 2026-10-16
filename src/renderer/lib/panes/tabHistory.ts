import type { TabHistory } from '@/lib/layout/tabFocus'

const RECENT_LIMIT = 64

const histories = new Map<string, { recent: string[]; openers: Record<string, string> }>()

function historyOf(workspaceId: string) {
  let history = histories.get(workspaceId)
  if (!history) {
    history = { recent: [], openers: {} }
    histories.set(workspaceId, history)
  }
  return history
}

export function tabHistoryOf(workspaceId: string): TabHistory {
  return histories.get(workspaceId) ?? { recent: [], openers: {} }
}

export function noteActivated(workspaceId: string, from: string, to: string): void {
  if (from === to) return
  const history = historyOf(workspaceId)
  delete history.openers[from]
  if (history.openers[to] !== from) delete history.openers[to]
  history.recent = [to, from, ...history.recent.filter((id) => id !== to && id !== from)].slice(
    0,
    RECENT_LIMIT,
  )
}

export function noteOpener(workspaceId: string, openedId: string, openerId: string): void {
  if (openedId === openerId) return
  historyOf(workspaceId).openers[openedId] = openerId
}

export function forgetTab(workspaceId: string, paneId: string): void {
  const history = histories.get(workspaceId)
  if (!history) return
  history.recent = history.recent.filter((id) => id !== paneId)
  delete history.openers[paneId]
  for (const [id, opener] of Object.entries(history.openers)) {
    if (opener === paneId) delete history.openers[id]
  }
}

export function forgetWorkspaceTabs(workspaceId: string): void {
  histories.delete(workspaceId)
}
