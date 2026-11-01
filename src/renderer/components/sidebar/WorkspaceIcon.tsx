import {
  BellRingingIcon,
  BroadcastIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  FlaskIcon,
  type Icon as IconComponent,
  MoonIcon,
  TerminalWindowIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react'
import { Hint } from '@/components/common/Hint'
import { fmt, useDict } from '@/lib/app/useDict'
import { allPanes } from '@/lib/layout/tree'
import type { LayoutNode } from '@/lib/layout/types'
import { cn } from '@/lib/utils'
import { type RowMark, rowMark } from '@/lib/workspaces/rowSummary'
import { useUnread } from '@/lib/workspaces/useUnread'
import { stateLabel } from '@/lib/workspaces/workspaceState'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import type { Workspace, WorkspaceKind } from '@/stores/workspaces/workspaceTypes'

const KIND_ICON: Record<WorkspaceKind, IconComponent> = {
  terminal: TerminalWindowIcon,
  scratch: FlaskIcon,
  manager: BroadcastIcon,
}

function isAsleep(root: LayoutNode): boolean {
  const terminals = allPanes(root).filter((p) => p.kind === 'terminal')
  return terminals.length > 0 && terminals.every((p) => p.hibernated)
}

const BADGE_SIZE = 12

const MARK_ICON: Record<RowMark, IconComponent> = {
  working: CircleNotchIcon,
  waiting: BellRingingIcon,
  error: WarningCircleIcon,
  done: CheckCircleIcon,
}

export function StateBadge({
  state,
  className,
  decorative = false,
}: {
  state: Workspace['state']
  className?: string
  decorative?: boolean
}): JSX.Element | null {
  const d = useDict()
  const mark = rowMark(state)
  if (!mark) return null
  const MarkIcon = MARK_ICON[mark]
  const cls = cn('state-badge', mark, className)
  if (decorative) {
    return (
      <span className={cls} aria-hidden>
        <MarkIcon size={BADGE_SIZE} aria-hidden />
      </span>
    )
  }
  return (
    <span className={cls} role="img" aria-label={stateLabel(d, mark)}>
      <MarkIcon size={BADGE_SIZE} aria-hidden />
    </span>
  )
}

export function WorkspaceIcon({ workspace }: { workspace: Workspace }): JSX.Element {
  const d = useDict()
  const root = useLayoutStore((s) => s.byWorkspace[workspace.id]?.root)
  const hibernated = root ? isAsleep(root) : false
  const KindIcon = hibernated ? MoonIcon : KIND_ICON[workspace.kind]
  const unread = useUnread([workspace.id]).n
  const scratch = workspace.kind === 'scratch'
  const label =
    unread > 0
      ? fmt(d.rail.unread, { n: unread })
      : hibernated
        ? d.pane.hibernated
        : scratch
          ? d.scratch.badgeHint
          : undefined
  const icon = (
    <KindIcon size={16} className="tab-lead" role={label ? 'img' : undefined} aria-label={label} />
  )
  return (
    <span className="tab-lead-wrap">
      <StateBadge state={workspace.state} className="workspace-badge" />
      {scratch && !hibernated ? <Hint label={d.scratch.badgeHint}>{icon}</Hint> : icon}
    </span>
  )
}
