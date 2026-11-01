import { StackIcon } from '@phosphor-icons/react'
import type { JSX } from 'react'
import { aggregateWorkspaceState } from '@/lib/attention/attention'
import type { WorkspaceGroup } from '@/lib/sidebar/workspaceGroups'
import type { Workspace } from '@/stores/workspaces/workspaceTypes'
import { StateBadge } from '../WorkspaceIcon'
import { RailCard } from './RailCard'

export function NarrowGroup({
  group,
  members,
  children,
}: {
  group: WorkspaceGroup
  members: Workspace[]
  children: React.ReactNode
}): JSX.Element {
  if (!group.collapsed) {
    return (
      <RailCard title={group.name} members={members} className="rail-group-box">
        {children}
      </RailCard>
    )
  }
  const urgent = aggregateWorkspaceState(members.map((w) => w.state))
  return (
    <RailCard title={group.name} members={members} pressOpens className="rail-group-stack">
      <button type="button" className="rail-stack" aria-label={group.name}>
        <StackIcon size={16} aria-hidden />
        <span className="rail-stack-count" aria-hidden>
          {members.length}
        </span>
        <StateBadge state={urgent} />
      </button>
    </RailCard>
  )
}
