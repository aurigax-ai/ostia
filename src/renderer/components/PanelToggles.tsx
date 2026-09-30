import { findExtensionPane } from '../layout/tree'
import { useExtensionsStore } from '../stores/extensionsStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useUIStore } from '../stores/uiStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { IconButton } from './IconButton'
import { extensionIcon } from './extensionIcons'

export function PanelToggles(): JSX.Element | null {
  const panels = useExtensionsStore((s) => s.list).filter((e) => e.enabled && e.panel)
  const workspaceId = useWorkspacesStore((s) => s.activeWorkspaceId)
  const root = useLayoutStore((s) => (workspaceId ? s.byWorkspace[workspaceId]?.root : undefined))
  if (!workspaceId || panels.length === 0) return null
  return (
    <>
      {panels.map((ext) => {
        const title = ext.panel?.title ?? ext.name
        const open = root ? findExtensionPane(root, ext.id) : null
        return (
          <IconButton
            key={ext.id}
            size="bar"
            icon={extensionIcon(ext.panel?.icon)}
            label={title}
            aria-pressed={open !== null}
            onClick={() => {
              useUIStore.getState().leaveSettings()
              const layout = useLayoutStore.getState()
              if (open) layout.closePane(workspaceId, open.id)
              else layout.openExtensionPanel(workspaceId, ext.id, title)
            }}
          />
        )
      })}
    </>
  )
}
