import { Notice } from '@/components/common/Notice'
import { fmt, useDict } from '@/lib/app/useDict'
import { paneTitleIn } from '@/lib/layout/paneTitle'
import type { PaneNode } from '@/lib/layout/types'
import { useWorktreeShareStore } from '@/stores/agents/worktreeShareStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { PaneNoticeStrip } from './PaneNoticeStrip'

export function SharedWorktreeNotice({ pane }: { pane: PaneNode }): JSX.Element | null {
  const d = useDict()
  const others = useWorktreeShareStore((s) => s.byPane[pane.id])
  const byWorkspace = useLayoutStore((s) => s.byWorkspace)
  if (!others || others.length === 0) return null
  const names = others.map((id) => paneTitleIn(byWorkspace, id) ?? d.mail.fromPane)
  return (
    <PaneNoticeStrip aria-label={d.pane.sharedWorktreeLabel} data-shared-worktree="">
      <Notice>
        <span className="[overflow-wrap:anywhere]">
          {fmt(d.pane.sharedWorktree, { panes: names.join(', ') })}
        </span>
      </Notice>
    </PaneNoticeStrip>
  )
}
