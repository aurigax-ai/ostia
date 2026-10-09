import { IconButton } from '@/components/common/IconButton'
import { useDict } from '@/i18n/useDict'
import { returnToMainWindow } from '@/lib/windowHandoff'
import { useWorkspacesStore } from '@/stores/workspacesStore'
import { ArrowSquareInIcon } from '@phosphor-icons/react'

export function DetachedTitleBar(): JSX.Element {
  const d = useDict()
  const project = useWorkspacesStore((s) => {
    const workspace = s.workspaces.find((w) => w.id === s.activeWorkspaceId)
    return workspace ? (workspace.customName ?? workspace.name) : ''
  })

  return (
    <header className="topbar detached-titlebar drag-region">
      <IconButton
        size="bar"
        icon={ArrowSquareInIcon}
        label={d.window.moveToMain}
        onClick={() => void returnToMainWindow()}
      />
      <h1 className="detached-title">{project}</h1>
      <span aria-hidden />
    </header>
  )
}
