import {
  BroadcastIcon,
  FlaskIcon,
  type Icon as IconComponent,
  MoonIcon,
  RobotIcon,
  TerminalWindowIcon,
} from '@phosphor-icons/react'
import { fmt, useDict } from '@/lib/app/useDict'
import { latestWaitingAt } from '@/lib/attention/attention'
import { allPanes, paneIds } from '@/lib/layout/tree'
import type { LayoutNode } from '@/lib/layout/types'
import { cn } from '@/lib/utils'
import { useUnread } from '@/lib/workspaces/useUnread'
import { stateLabel } from '@/lib/workspaces/workspaceState'
import { useAttentionStore } from '@/stores/agents/attentionStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import type { Workspace, WorkspaceKind } from '@/stores/workspaces/workspaceTypes'

const KIND_ICON: Record<WorkspaceKind, IconComponent> = {
  agent: RobotIcon,
  terminal: TerminalWindowIcon,
  scratch: FlaskIcon,
  manager: BroadcastIcon,
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
