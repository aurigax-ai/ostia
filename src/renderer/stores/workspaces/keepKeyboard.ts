import { keyboardPaneId } from '@/lib/layout/focusDirection'
import { isPaneShown } from '@/lib/layout/tree'
import type { LayoutGet } from './layoutTypes'
import { focusSurfaceWhenReady } from './surfaceSlotsStore'

export function keepKeyboard(get: LayoutGet, workspaceId: string): void {
  const layout = get().byWorkspace[workspaceId]
  if (!layout) return
  const target = keyboardPaneId(layout)
  focusSurfaceWhenReady(target, () => {
    const now = get().byWorkspace[workspaceId]
    return now !== undefined && isPaneShown(now.root, target)
  })
}
