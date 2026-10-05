import { AppWindowIcon, LockSimpleIcon, LockSimpleOpenIcon } from '@phosphor-icons/react'
import { isRemotePath } from '@shared/remoteFolders'
import type { ReactElement } from 'react'
import { commands } from '../commands/registry'
import { useDict } from '../i18n/useDict'
import type { PaneNode } from '../layout/types'
import { runUserAction } from '../lib/userActions'
import { canMovePane, movePaneToNewWindow } from '../lib/windowHandoff'
import { actionsFor } from '../settings/actions'
import { useSettingsStore } from '../stores/settingsStore'
import { FileMenuItems } from './FileMenu'
import { IconButton } from './IconButton'
import { MenuContent, MenuItem } from './Menu'
import { actionIcon } from './actionIcons'
import { ContextMenu, ContextMenuSeparator, ContextMenuTrigger } from './ui/context-menu'

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
  const actions = useSettingsStore((s) => s.actions)
  const tabActions = actionsFor(actions, 'tabMenu', pane.kind)
  const file =
    pane.kind === 'editor' && workspaceId && !isRemotePath(pane.filePath)
      ? pane.filePath
      : undefined
  const movable = workspaceId !== null && canMovePane(workspaceId, pane.id)
  const lockable = workspaceId !== null && pane.kind !== 'manager'
  if (!file && tabActions.length === 0 && !movable && !lockable) return trigger

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
        {(movable || lockable) && (file || tabActions.length > 0) ? <ContextMenuSeparator /> : null}
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
