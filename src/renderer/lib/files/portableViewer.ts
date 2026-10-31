import { allPanes } from '@/lib/layout/tree'
import type { PaneNode } from '@/lib/layout/types'
import { useExtensionsStore } from '@/stores/extensions/extensionsStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { viewerOptions } from './viewerChoice'

function paneShowing(workspaceId: string, filePath: string): PaneNode | null {
  const root = useLayoutStore.getState().byWorkspace[workspaceId]?.root
  if (!root) return null
  return allPanes(root).find((pane) => pane.kind === 'editor' && pane.filePath === filePath) ?? null
}

export function showInViewer(workspaceId: string, filePath: string): boolean {
  const options = viewerOptions(filePath, useExtensionsStore.getState().list)
  const option = options.find((candidate) => candidate.priority === 'default') ?? options[0]
  if (!option) return false
  const layout = useLayoutStore.getState()
  if (!paneShowing(workspaceId, filePath)) layout.openFile(workspaceId, filePath)
  const pane = paneShowing(workspaceId, filePath)
  if (!pane) return false
  layout.setViewType(workspaceId, pane.id, option.viewType)
  return true
}

export function chipPaneFor(workspaceId: string, filePath: string, paneId?: string): string | null {
  return (
    paneId ??
    paneShowing(workspaceId, filePath)?.id ??
    useLayoutStore.getState().byWorkspace[workspaceId]?.activePaneId ??
    null
  )
}
