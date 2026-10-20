import { Hint } from '@/components/common/Hint'
import { MailCount } from '@/components/common/MailCount'
import { Badge } from '@/components/ui/badge'
import { useDict } from '@/lib/app/useDict'
import { paneIds } from '@/lib/layout/tree'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import type { Workspace } from '@/stores/workspaces/workspaceTypes'
import { LockSimpleIcon, PushPinSimpleIcon, ShieldCheckIcon } from '@phosphor-icons/react'

function ScratchBadge(): JSX.Element {
  const d = useDict()
  return (
    <Hint label={d.scratch.badgeHint}>
      <Badge variant="outline" className="scratch-badge h-4 rounded-sm px-1 text-ui-xs">
        {d.scratch.badge}
      </Badge>
    </Hint>
  )
}

function WorkspaceMail({ workspaceId }: { workspaceId: string }): JSX.Element | null {
  const root = useLayoutStore((s) => s.byWorkspace[workspaceId]?.root)
  return root ? <MailCount paneIds={paneIds(root)} /> : null
}

export function WorkspaceBadges({
  workspace: w,
  sandboxed,
  locked,
}: {
  workspace: Workspace
  sandboxed: boolean
  locked: boolean
}): JSX.Element {
  const d = useDict()
  return (
    <>
      {w.kind === 'scratch' ? <ScratchBadge /> : null}
      <WorkspaceMail workspaceId={w.id} />
      {w.pinned ? (
        <PushPinSimpleIcon size={16} className="tab-pin" aria-label={d.rail.pinned} />
      ) : null}
      {sandboxed ? (
        <ShieldCheckIcon size={16} className="tab-pin" role="img" aria-label={d.rail.sandboxed} />
      ) : null}
      {locked ? (
        <LockSimpleIcon size={16} className="tab-lock" role="img" aria-label={d.rail.locked} />
      ) : null}
    </>
  )
}
