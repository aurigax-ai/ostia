import type { ExtensionInfo } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import type { JSX } from 'react'
import { IconButton } from '@/components/common/IconButton'
import { extensionIcon } from '@/components/extensions/extensionIcons'
import { toggleRightPanel } from '@/lib/panes/rightPanelFocus'
import { useSidePanelStore } from '@/stores/app/sidePanelStore'
import { useExtensionsStore } from '@/stores/extensions/extensionsStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'

function hasToggle(ext: ExtensionInfo): boolean {
  return ext.enabled && ext.panel !== null && ext.assist.length === 0
}

export function PanelToggles(): JSX.Element | null {
  const panels = useExtensionsStore((s) => s.list).filter(hasToggle)
  const right = useSidePanelStore((s) => s.right)
  const workspaceId = useWorkspacesStore((s) => s.activeWorkspaceId)
  if (!workspaceId || panels.length === 0) return null
  return (
    <>
      {panels.map((ext) => (
        <IconButton
          key={ext.id}
          size="bar"
          icon={extensionIcon(ext.panel?.icon)}
          label={ext.panel?.title ?? ext.name}
          aria-pressed={right === ext.id}
          onClick={() => toggleRightPanel(ext.id)}
        />
      ))}
    </>
  )
}
