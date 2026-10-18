import { IconButton } from '@/components/common/IconButton'
import { extensionIcon } from '@/components/extensions/extensionIcons'
import { findExtensionPane } from '@/lib/layout/paneFields'
import { useUIStore } from '@/stores/app/uiStore'
import { useExtensionsStore } from '@/stores/extensions/extensionsStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import type { ExtensionInfo } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'

function hasToggle(ext: ExtensionInfo): boolean {
  return ext.enabled && ext.panel !== null && ext.assist.length === 0
}

export function PanelToggles(): JSX.Element | null {
  const panels = useExtensionsStore((s) => s.list).filter(hasToggle)
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
              useUIStore.getState().showWorkspaces()
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
