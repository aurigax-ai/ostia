import type { JSX } from 'react'
import { fmt, useDict } from '@/lib/app/useDict'
import { aggregateWorkspaceState } from '@/lib/attention/attention'
import { useUnread } from '@/lib/workspaces/useUnread'
import { stateLabel } from '@/lib/workspaces/workspaceState'
import type { Workspace } from '@/stores/workspaces/workspaceTypes'

export function GroupStatus({ members }: { members: Workspace[] }): JSX.Element | null {
  const d = useDict()
  const state = aggregateWorkspaceState(members.map((w) => w.state))
  if (state === 'idle') return null
  return (
    <span className={`dot rail-group-dot ${state}`} role="img" aria-label={stateLabel(d, state)} />
  )
}

export function GroupUnreadDot({ workspaceIds }: { workspaceIds: string[] }): JSX.Element | null {
  const d = useDict()
  const { n } = useUnread(workspaceIds)
  if (n === 0) return null
  return <span className="unread-dot" role="img" aria-label={fmt(d.rail.unread, { n })} />
}
