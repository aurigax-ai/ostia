import { allPanes } from '@/layout/tree'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'

export function livePaneIds(): string[] {
  const ids: string[] = []
  for (const layout of Object.values(useLayoutStore.getState().byWorkspace)) {
    if (layout) for (const pane of allPanes(layout.root)) ids.push(pane.id)
  }
  return ids
}
