import { currentDict } from '@/lib/app/useDict'
import { createTerminalPane } from '@/lib/layout/tree'
import type { LayoutNode, PaneNode } from '@/lib/layout/types'
import { layoutOf } from '@/lib/panes/layoutPatch'
import type { LayoutGet, LayoutSet } from './layoutTypes'
import { workspaceOf } from './workspaceLookup'

export function neutralTerminalTitle(): string {
  return currentDict().pane.terminalTitle
}

export function newTerminalPane(cwd?: string): PaneNode {
  return createTerminalPane(neutralTerminalTitle(), cwd)
}

export function announcePaneCreated(workspaceId: string, paneId: string | null): void {
  if (paneId) window.ostia.lifecycle.emit({ type: 'pane-created', workspaceId, paneId })
}

export function seedLayout(
  set: LayoutSet,
  get: LayoutGet,
  workspaceId: string,
  make: (pane: PaneNode) => LayoutNode,
): string | null {
  if (get().byWorkspace[workspaceId]) return null
  if (!workspaceOf(workspaceId)) return null
  const pane = newTerminalPane()
  set((s) => ({
    byWorkspace: { ...s.byWorkspace, [workspaceId]: layoutOf(make(pane)) },
  }))
  announcePaneCreated(workspaceId, pane.id)
  return pane.id
}
