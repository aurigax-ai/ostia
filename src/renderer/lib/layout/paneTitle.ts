import { allPanes } from './tree'
import type { LayoutNode } from './types'

export function paneTitleIn(
  layouts: Record<string, { root: LayoutNode }>,
  paneId: string,
): string | undefined {
  for (const layout of Object.values(layouts)) {
    const found = allPanes(layout.root).find((pane) => pane.id === paneId)
    if (found) return found.title
  }
  return undefined
}
