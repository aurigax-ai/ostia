import { findPane } from '@/layout/tree'
import { formatWindowTitle } from '@/settings/windowTitle'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { PRODUCT_DISPLAY_NAME } from '@shared/productDisplay'
import { useEffect } from 'react'

export function useWindowTitle(): void {
  const template = useSettingsStore((s) => s.appearance.windowTitle)
  const workspace = useWorkspacesStore((s) =>
    s.workspaces.find((w) => w.id === s.activeWorkspaceId),
  )
  const pane = useLayoutStore((s) => {
    const layout = workspace ? s.byWorkspace[workspace.id] : undefined
    return layout ? findPane(layout.root, layout.activePaneId) : null
  })
  const title = formatWindowTitle(template, {
    product: PRODUCT_DISPLAY_NAME,
    workspace: workspace ? (workspace.customName ?? workspace.name) : undefined,
    pane: pane?.title,
    cwd: pane?.cwd ?? workspace?.workDir,
  })
  useEffect(() => {
    document.title = title
  }, [title])
}
