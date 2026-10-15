import { Hint } from '@/components/common/Hint'
import { Badge } from '@/components/ui/badge'
import { fmt, useDict } from '@/lib/app/useDict'
import { aggregateWorkspaceState, latestWaitingAt, unreadCount } from '@/lib/attention/attention'
import { allPanes, paneIds } from '@/lib/layout/tree'
import type { LayoutNode } from '@/lib/layout/types'
import { cn } from '@/lib/utils'
import { useAttentionStore } from '@/stores/agents/attentionStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import type { Workspace, WorkspaceKind, WorkspaceState } from '@/stores/workspaces/workspaceTypes'
import {
  BroadcastIcon,
  FlaskIcon,
  type Icon as IconComponent,
  LockSimpleIcon,
  MoonIcon,
  PushPinSimpleIcon,
  RobotIcon,
  ShieldCheckIcon,
  TerminalWindowIcon,
} from '@phosphor-icons/react'
import type { Dict } from '@shared/app/dict'
import { useState } from 'react'

const KIND_ICON: Record<WorkspaceKind, IconComponent> = {
  agent: RobotIcon,
  terminal: TerminalWindowIcon,
  scratch: FlaskIcon,
  manager: BroadcastIcon,
}

export function GroupStatus({ members }: { members: Workspace[] }): JSX.Element | null {
  const d = useDict()
  const state = aggregateWorkspaceState(members.map((w) => w.state))
  if (state === 'idle') return null
  return (
    <span className={`dot rail-group-dot ${state}`} role="img" aria-label={stateLabel(d, state)} />
  )
}

export function stateLabel(d: Dict, state: WorkspaceState): string {
  const labels: Record<WorkspaceState, string> = {
    idle: d.rail.stateIdle,
    working: d.rail.stateWorking,
    waiting: d.rail.stateWaiting,
    done: d.rail.stateDone,
    error: d.rail.stateError,
  }
  return labels[state]
}

function isAsleep(root: LayoutNode): boolean {
  const terminals = allPanes(root).filter((p) => p.kind === 'terminal')
  return terminals.length > 0 && terminals.every((p) => p.hibernated)
}

export function WorkspaceIcon({ workspace }: { workspace: Workspace }): JSX.Element {
  const d = useDict()
  const root = useLayoutStore((s) => s.byWorkspace[workspace.id]?.root)
  const hibernated = root ? isAsleep(root) : false
  const KindIcon = hibernated ? MoonIcon : KIND_ICON[workspace.kind]
  const waitingAt = useAttentionStore((s) => (root ? latestWaitingAt(s.byPane, paneIds(root)) : 0))
  const unread = useUnread([workspace.id])
  return (
    <span className="tab-lead-wrap">
      <span
        key={workspace.state === 'waiting' ? `waiting-${waitingAt}` : 'steady'}
        className={`dot workspace-dot ${workspace.state}`}
        role="img"
        aria-label={stateLabel(d, workspace.state)}
      />
      <KindIcon
        key={unread.n > 0 ? `unread-${unread.generation}` : 'read'}
        size={16}
        className={cn('tab-lead', unread.n > 0 && 'tab-lead-unread')}
        role={hibernated || unread.n > 0 ? 'img' : undefined}
        aria-label={
          unread.n > 0
            ? fmt(d.rail.unread, { n: unread.n })
            : hibernated
              ? d.pane.hibernated
              : undefined
        }
      />
    </span>
  )
}

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

function useUnread(workspaceIds: string[]): { n: number; generation: number } {
  const byWorkspace = useLayoutStore((s) => s.byWorkspace)
  const n = useAttentionStore((s) => {
    let total = 0
    for (const id of workspaceIds) {
      const root = byWorkspace[id]?.root
      if (root) total += unreadCount(s.byPane, paneIds(root))
    }
    return total
  })
  const [seen, setSeen] = useState({ n: 0, generation: 0 })
  if (seen.n !== n) setSeen({ n, generation: n > seen.n ? seen.generation + 1 : seen.generation })
  return { n, generation: seen.generation }
}

export function GroupUnreadDot({ workspaceIds }: { workspaceIds: string[] }): JSX.Element | null {
  const d = useDict()
  const { n } = useUnread(workspaceIds)
  if (n === 0) return null
  return <span className="unread-dot" role="img" aria-label={fmt(d.rail.unread, { n })} />
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
      {w.pinned ? (
        <PushPinSimpleIcon size={12} className="tab-pin" aria-label={d.rail.pinned} />
      ) : null}
      {sandboxed ? (
        <ShieldCheckIcon size={12} className="tab-pin" role="img" aria-label={d.rail.sandboxed} />
      ) : null}
      {locked ? (
        <LockSimpleIcon size={12} className="tab-lock" role="img" aria-label={d.rail.locked} />
      ) : null}
    </>
  )
}
