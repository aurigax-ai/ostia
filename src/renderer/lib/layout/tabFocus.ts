import { selectTab, tabIndex, tabsOfPane } from './tree'
import type { LayoutNode } from './types'

export interface TabHistory {
  recent: readonly string[]
  openers: Readonly<Record<string, string>>
}

export function focusAfterClose(
  root: LayoutNode,
  closedId: string,
  history: TabHistory,
): string | null {
  const tabs = tabsOfPane(root, closedId)
  if (!tabs || tabs.activeId !== closedId) return null
  const closed = tabs.children[tabIndex(tabs, closedId)]
  if (closed.type !== 'pane') return null
  const usable = (id: string | undefined): id is string => {
    if (!id) return false
    const at = tabIndex(tabs, id)
    return at !== -1 && tabs.children[at] !== closed
  }
  const opener = history.openers[closedId]
  if (usable(opener)) return opener
  return history.recent.find(usable) ?? null
}

export function showAfterClose(root: LayoutNode, shownId: string | null): LayoutNode {
  return shownId ? selectTab(root, shownId) : root
}
