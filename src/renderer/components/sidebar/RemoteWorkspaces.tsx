import { AppWindowIcon, ArrowSquareInIcon } from '@phosphor-icons/react'
import { MenuContent, MenuItem } from '@/components/common/Menu'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Kbd } from '@/components/ui/kbd'
import { useDict } from '@/lib/app/useDict'
import { type RemoteWorkspace, remoteWorkspacesOf } from '@/lib/workspaces/windowWorkspaces'
import { useUIStore } from '@/stores/app/uiStore'
import { useWindowsStore } from '@/stores/workspaces/windowsStore'
import { PathLine } from './RailMeta'
import { RailTab } from './RailTab'
import { StateBadge } from './WorkspaceIcon'

export function RemoteWorkspaces({ offset }: { offset: number }): JSX.Element | null {
  const windowId = useWindowsStore((s) => s.windowId)
  const list = useWindowsStore((s) => s.list)
  const remote = remoteWorkspacesOf(list, windowId)
  if (remote.length === 0) return null
  return (
    <>
      {remote.map((w, i) => (
        <RemoteWorkspaceRow key={w.id} workspace={w} index={offset + i} />
      ))}
    </>
  )
}

function RemoteWorkspaceRow({
  workspace: w,
  index,
}: {
  workspace: RemoteWorkspace
  index: number
}): JSX.Element {
  const d = useDict()
  const digitHints = useUIStore((s) => s.digitHints)
  const show = (): void => window.ostia.windows.focusWorkspace(w.id, false, true)
  return (
    <ContextMenu>
      <ContextMenuTrigger className="rail-row remote">
        <RailTab
          active={false}
          onSelect={show}
          closeLabel={d.rail.close}
          icon={
            <span className="tab-lead-wrap">
              <StateBadge state={w.state} className="workspace-badge" />
              <AppWindowIcon size={16} className="tab-lead" aria-label={d.window.inOtherWindow} />
            </span>
          }
          title={w.name}
          after={
            // biome-ignore lint/a11y/useKeyWithClickEvents: the row button above is the keyboard target; this only widens the click area
            <div className="tab-after" onClick={show}>
              <PathLine path={w.workDir} />
            </div>
          }
          badge={digitHints && index < 9 ? <Kbd className="tab-digit">{index + 1}</Kbd> : null}
        />
      </ContextMenuTrigger>
      <MenuContent>
        <MenuItem icon={AppWindowIcon} onClick={show}>
          {d.window.showWindow}
        </MenuItem>
        <MenuItem
          icon={ArrowSquareInIcon}
          onClick={() => window.ostia.windows.returnWorkspace(w.id)}
        >
          {d.window.moveToMain}
        </MenuItem>
      </MenuContent>
    </ContextMenu>
  )
}
