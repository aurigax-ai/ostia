import { PRODUCT_DISPLAY_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/productDisplay'
import { useEffect } from 'react'
import { findPane } from '@/lib/layout/tree'
import { formatWindowTitle } from '@/lib/settings/windowTitle'
import { workspaceTitle } from '@/lib/workspaces/workspaceTitle'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'

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
    workspace: workspace ? workspaceTitle(workspace) : undefined,
    pane: pane?.title,
    cwd: pane?.cwd ?? workspace?.workDir,
  })
  useEffect(() => {
    document.title = title
  }, [title])
}
