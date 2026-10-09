import { commands } from '@/commands/registry'
import { IconButton } from '@/components/common/IconButton'
import { MenuContent, MenuItem } from '@/components/common/Menu'
import { FileMenuItems } from '@/components/files/FileMenu'
import { actionIcon } from '@/components/settings/actionIcons'
import { ContextMenu, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { useDict } from '@/i18n/useDict'
import { splitTabOfPane } from '@/layout/tree'
import type { PaneNode } from '@/layout/types'
import { useChordLabel } from '@/lib/keys/chords'
import { runUserAction } from '@/lib/palette/userActions'
import { canMovePane, movePaneToNewWindow } from '@/lib/workspaces/windowHandoff'
import { isMac } from '@/platform'
import { actionsFor } from '@/settings/actions'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import {
  AppWindowIcon,
  ArrowsInIcon,
  ArrowsOutIcon,
  LockSimpleIcon,
  LockSimpleOpenIcon,
} from '@phosphor-icons/react'
import { isRemotePath } from '@shared/remoteFolders'
import type { ReactElement } from 'react'
import { TabMoveMenuItems } from './TabMoveMenuItems'

export function PaneTabMenu({
  pane,
  workspaceId,
  trigger,
}: {
  pane: PaneNode
  workspaceId: string | null
  trigger: ReactElement
}): JSX.Element {
  const d = useDict()
  const zoomKeys = useChordLabel('pane.zoom', isMac)
  const actions = useSettingsStore((s) => s.actions)
  const tabActions = actionsFor(actions, 'tabMenu', pane.kind)
  const file =
    pane.kind === 'editor' && workspaceId && !isRemotePath(pane.filePath)
      ? pane.filePath
      : undefined
  const movable = workspaceId !== null && canMovePane(workspaceId, pane.id)
  const lockable = workspaceId !== null && pane.kind !== 'manager'
  const zoom = useLayoutStore((s) => {
    const layout = workspaceId ? s.byWorkspace[workspaceId] : undefined
    if (!layout) return null
    if (layout.zoomedPaneId === pane.id) return 'zoomed'
    const shared = layout.root.type === 'split' || splitTabOfPane(layout.root, pane.id) !== null
    return shared ? 'zoomable' : null
  })
  if (!file && tabActions.length === 0 && !movable && !lockable && !zoom) return trigger

  return (
    <ContextMenu>
      <ContextMenuTrigger render={trigger} />
      <MenuContent>
        {file && workspaceId ? (
          <FileMenuItems workspaceId={workspaceId} path={file} inOstia />
        ) : null}
        {file && tabActions.length > 0 ? <ContextMenuSeparator /> : null}
        {tabActions.map((action) => (
          <MenuItem
            key={action.id}
            icon={actionIcon(action.icon)}
            onClick={() => void runUserAction(action, pane.id)}
          >
            {action.title}
          </MenuItem>
        ))}
        {(movable || lockable || zoom) && (file || tabActions.length > 0) ? (
          <ContextMenuSeparator />
        ) : null}
        {zoom ? (
          <MenuItem
            icon={zoom === 'zoomed' ? ArrowsInIcon : ArrowsOutIcon}
            hint={zoomKeys}
            onClick={() => void commands.exec('pane.zoom', { paneId: pane.id })}
          >
            {zoom === 'zoomed' ? d.pane.unzoom : d.pane.zoom}
          </MenuItem>
        ) : null}
        {lockable ? (
          <MenuItem
            icon={pane.locked ? LockSimpleOpenIcon : LockSimpleIcon}
            onClick={() => void commands.exec('pane.toggleLock', { paneId: pane.id })}
          >
            {pane.locked ? d.pane.unlock : d.pane.lock}
          </MenuItem>
        ) : null}
        {movable && workspaceId ? (
          <MenuItem
            icon={AppWindowIcon}
            onClick={() => void movePaneToNewWindow(workspaceId, pane.id)}
          >
            {d.window.movePaneToNewWindow}
          </MenuItem>
        ) : null}
        {lockable && workspaceId ? (
          <TabMoveMenuItems workspaceId={workspaceId} tabId={pane.id} />
        ) : null}
      </MenuContent>
    </ContextMenu>
  )
}

export function PaneHeaderActions({ pane }: { pane: PaneNode }): JSX.Element {
  const actions = useSettingsStore((s) => s.actions)
  return (
    <>
      {actionsFor(actions, 'paneHeader', pane.kind).map((action) => (
        <IconButton
          key={action.id}
          icon={actionIcon(action.icon)}
          label={action.title}
          onClick={() => void runUserAction(action, pane.id)}
        />
      ))}
    </>
  )
}
