import { LockSimpleIcon, PushPinSimpleIcon, ShieldCheckIcon } from '@phosphor-icons/react'
import { useEffect } from 'react'
import { Hint } from '@/components/common/Hint'
import { MailCount } from '@/components/common/MailCount'
import { Badge } from '@/components/ui/badge'
import { useDict } from '@/lib/app/useDict'
import { hasLockedPane } from '@/lib/layout/paneFields'
import { paneIds } from '@/lib/layout/tree'
import { useSandboxStore } from '@/stores/app/sandboxStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import type { Workspace } from '@/stores/workspaces/workspaceTypes'

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

export function useWorkspaceFlags(workspaceId: string): { sandboxed: boolean; locked: boolean } {
  const sandboxed = useSandboxStore((s) => s.enabled[workspaceId] ?? false)
  const locked = useLayoutStore((s) => {
    const root = s.byWorkspace[workspaceId]?.root
    return root ? hasLockedPane(root) : false
  })
  return { sandboxed, locked }
}

export function WorkspaceBadges({
  workspace: w,
  marksOnly = false,
}: {
  workspace: Workspace
  marksOnly?: boolean
}): JSX.Element {
  const d = useDict()
  const { sandboxed, locked } = useWorkspaceFlags(w.id)
  useEffect(() => {
    if (!marksOnly) void useSandboxStore.getState().load(w.id)
  }, [w.id, marksOnly])
  return (
    <>
      {w.kind === 'scratch' ? <ScratchBadge /> : null}
      {marksOnly ? null : <WorkspaceMail workspaceId={w.id} />}
      {w.pinned ? (
        <PushPinSimpleIcon size={16} className="tab-pin" aria-label={d.rail.pinned} />
      ) : null}
      {sandboxed && !marksOnly ? (
        <ShieldCheckIcon size={16} className="tab-pin" role="img" aria-label={d.rail.sandboxed} />
      ) : null}
      {locked && !marksOnly ? (
        <LockSimpleIcon size={16} className="tab-lock" role="img" aria-label={d.rail.locked} />
      ) : null}
    </>
  )
}
