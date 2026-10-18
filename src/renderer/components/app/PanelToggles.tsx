import { IconButton } from '@/components/common/IconButton'
import { extensionIcon } from '@/components/extensions/extensionIcons'
import { useDict } from '@/lib/app/useDict'
import { openGit } from '@/lib/git/gitPanel'
import { firstPaneOfKind } from '@/lib/layout/paneFields'
import { toggleRightPanel } from '@/lib/panes/rightPanelFocus'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useSidePanelStore } from '@/stores/app/sidePanelStore'
import { useExtensionsStore } from '@/stores/extensions/extensionsStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import type { ExtensionInfo } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { GitBranchIcon } from '@phosphor-icons/react'

function hasToggle(ext: ExtensionInfo): boolean {
  return ext.enabled && ext.panel !== null && ext.assist.length === 0
}

export function PanelToggles(): JSX.Element | null {
  const d = useDict()
  const panels = useExtensionsStore((s) => s.list).filter(hasToggle)
  const git = useSettingsStore((s) => s.git.enabled)
  const right = useSidePanelStore((s) => s.right)
  const workspaceId = useWorkspacesStore((s) => s.activeWorkspaceId)
  const root = useLayoutStore((s) => (workspaceId ? s.byWorkspace[workspaceId]?.root : undefined))
  if (!workspaceId || (panels.length === 0 && !git)) return null
  const gitPane = root ? firstPaneOfKind(root, 'git') : null
  return (
    <>
      {git && (
        <IconButton
          size="bar"
          icon={GitBranchIcon}
          label={d.git.title}
          aria-pressed={gitPane !== null}
          onClick={() => {
            if (gitPane) useLayoutStore.getState().closePane(workspaceId, gitPane.id)
            else openGit(workspaceId, 'changes')
          }}
        />
      )}
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
