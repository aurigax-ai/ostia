import { ArrowsMergeIcon, type Icon } from '@phosphor-icons/react'
import { type JSX, useEffect, useState } from 'react'
import { MenuItem, MenuSubContent, MenuSubTrigger } from '@/components/common/Menu'
import { ContextMenuSub } from '@/components/ui/context-menu'
import { fmt, useDict } from '@/lib/app/useDict'
import { mergeRefusalText } from '@/lib/workspaces/mergeRefusalText'
import {
  loadMergeTargets,
  type MergeTarget,
  requestMergeWorkspace,
} from '@/lib/workspaces/workspaceMerge'

export function MergeMenuItems({ workspaceId }: { workspaceId: string }): JSX.Element | null {
  const d = useDict()
  const [targets, setTargets] = useState<MergeTarget[]>([])
  useEffect(() => {
    let live = true
    void loadMergeTargets(workspaceId).then((next) => {
      if (live) setTargets(next)
    })
    return () => {
      live = false
    }
  }, [workspaceId])
  if (targets.length === 0) return null
  const item = (target: MergeTarget, label: string, icon?: Icon): JSX.Element => (
    <MenuItem
      key={target.id}
      icon={icon}
      disabled={target.refusal !== null}
      hint={mergeRefusalText(d, target.refusal)}
      onClick={() => void requestMergeWorkspace(workspaceId, target.id)}
    >
      {label}
    </MenuItem>
  )
  if (targets.length === 1) {
    const [only] = targets
    return item(only, fmt(d.merge.menuInto, { name: only.name }), ArrowsMergeIcon)
  }
  return (
    <ContextMenuSub>
      <MenuSubTrigger icon={ArrowsMergeIcon}>{d.merge.menu}</MenuSubTrigger>
      <MenuSubContent>{targets.map((t) => item(t, t.name))}</MenuSubContent>
    </ContextMenuSub>
  )
}
