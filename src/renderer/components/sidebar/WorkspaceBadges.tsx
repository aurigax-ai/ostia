import {
  CoffeeIcon,
  LockSimpleIcon,
  PushPinSimpleIcon,
  ShieldCheckIcon,
} from '@phosphor-icons/react'
import { useEffect } from 'react'
import { Hint } from '@/components/common/Hint'
import { MailCount } from '@/components/common/MailCount'
import { Badge } from '@/components/ui/badge'
import { fmt, useDict } from '@/lib/app/useDict'
import { hasLockedPane } from '@/lib/layout/paneFields'
import { allPanes, paneIds } from '@/lib/layout/tree'
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

const KEPT_AWAKE_NAMED_MAX = 3

function WorkspaceKeptAwake({ workspaceId }: { workspaceId: string }): JSX.Element | null {
  const d = useDict()
  const root = useLayoutStore((s) => s.byWorkspace[workspaceId]?.root)
  const titles = root
    ? allPanes(root)
        .filter((pane) => pane.keepAwake)
        .map((pane) => pane.title)
    : []
  if (titles.length === 0) return null
  const label =
    titles.length > KEPT_AWAKE_NAMED_MAX
      ? fmt(d.rail.keptAwakeMany, { count: titles.length })
      : fmt(d.rail.keptAwake, { names: titles.join(', ') })
  return (
    <Hint label={label}>
      <CoffeeIcon size={16} className="tab-pin" role="img" aria-label={label} />
    </Hint>
  )
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
      {marksOnly ? null : <WorkspaceKeptAwake workspaceId={w.id} />}
      {sandboxed && !marksOnly ? (
        <ShieldCheckIcon size={16} className="tab-pin" role="img" aria-label={d.rail.sandboxed} />
      ) : null}
      {locked && !marksOnly ? (
        <LockSimpleIcon size={16} className="tab-lock" role="img" aria-label={d.rail.locked} />
      ) : null}
    </>
  )
}
