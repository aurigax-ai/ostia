import type { ReactElement } from 'react'
import type { PaneNode } from '../layout/types'
import { runUserAction } from '../lib/userActions'
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
  const actions = useSettingsStore((s) => s.actions)
  const tabActions = actionsFor(actions, 'tabMenu', pane.kind)
  const file = pane.kind === 'editor' && workspaceId ? pane.filePath : undefined
  if (!file && tabActions.length === 0) return trigger

  return (
    <ContextMenu>
      <ContextMenuTrigger render={trigger} />
      <MenuContent>
        {file && workspaceId ? (
          <FileMenuItems workspaceId={workspaceId} path={file} inPine />
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
