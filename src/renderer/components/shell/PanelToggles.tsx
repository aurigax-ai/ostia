import { IconButton } from '@/components/common/IconButton'
import { extensionIcon } from '@/components/extensions/extensionIcons'
import { useDict } from '@/i18n/useDict'
import { findExtensionPane, firstPaneOfKind } from '@/layout/tree'
import { openGit } from '@/lib/gitPanel'
import { useExtensionsStore } from '@/stores/extensionsStore'
import { useLayoutStore } from '@/stores/layoutStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useUIStore } from '@/stores/uiStore'
import { useWorkspacesStore } from '@/stores/workspacesStore'
import { GitBranchIcon } from '@phosphor-icons/react'
import type { ExtensionInfo } from '@shared/extensions'

function hasToggle(ext: ExtensionInfo): boolean {
  return ext.enabled && ext.panel !== null && ext.assist.length === 0
}

export function PanelToggles(): JSX.Element | null {
  const d = useDict()
  const panels = useExtensionsStore((s) => s.list).filter(hasToggle)
  const git = useSettingsStore((s) => s.git.enabled)
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
