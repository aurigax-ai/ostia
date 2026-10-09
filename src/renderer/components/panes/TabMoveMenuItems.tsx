import { MenuItem, MenuSubContent, MenuSubTrigger } from '@/components/common/Menu'
import { ContextMenuSub } from '@/components/ui/context-menu'
import { useDict } from '@/i18n/useDict'
import { tabMoveRefusalText } from '@/lib/workspaces/tabMoveRefusalText'
import { moveTabToWorkspace, tabMoveTargets } from '@/lib/workspaces/tabWorkspaceMove'
import { ArrowSquareInIcon } from '@phosphor-icons/react'

export function TabMoveMenuItems({
  workspaceId,
  tabId,
}: {
  workspaceId: string
  tabId: string
}): JSX.Element | null {
  const d = useDict()
  const targets = tabMoveTargets(workspaceId, tabId)
  if (targets.length === 0) return null
  return (
    <ContextMenuSub>
      <MenuSubTrigger icon={ArrowSquareInIcon}>{d.tabMove.menu}</MenuSubTrigger>
      <MenuSubContent>
        {targets.map((target) => (
          <MenuItem
            key={target.id}
            disabled={target.refusal !== null}
            hint={tabMoveRefusalText(d, target.refusal)}
            onClick={() => void moveTabToWorkspace(workspaceId, tabId, target.id)}
          >
            {target.name}
          </MenuItem>
        ))}
      </MenuSubContent>
    </ContextMenuSub>
  )
}
