import { ArrowSquareInIcon } from '@phosphor-icons/react'
import { IconButton } from '@/components/common/IconButton'
import { useDict } from '@/lib/app/useDict'
import { returnToMainWindow } from '@/lib/workspaces/windowHandoff'
import { workspaceTitle } from '@/lib/workspaces/workspaceTitle'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'

export function DetachedTitleBar(): JSX.Element {
  const d = useDict()
  const project = useWorkspacesStore((s) => {
    const workspace = s.workspaces.find((w) => w.id === s.activeWorkspaceId)
    return workspace ? workspaceTitle(workspace) : ''
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
