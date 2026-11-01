import type { ExtensionSidebarItem } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { TerminalWindowIcon } from '@phosphor-icons/react'
import type { JSX } from 'react'
import { Hint } from '@/components/common/Hint'
import { MailCount } from '@/components/common/MailCount'
import { fmt, useDict } from '@/lib/app/useDict'
import { allPanes, paneIds } from '@/lib/layout/tree'
import { liveTerminalCount } from '@/lib/workspaces/rowSummary'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { LiveLine } from '../RailMeta'

function TabCount({ workspaceId }: { workspaceId: string }): JSX.Element | null {
  const d = useDict()
  const count = useLayoutStore((s) => {
    const root = s.byWorkspace[workspaceId]?.root
    return root ? liveTerminalCount(allPanes(root)) : 0
  })
  if (count === 0) return null
  const label = count === 1 ? d.rail.terminalTabsOne : fmt(d.rail.terminalTabs, { n: count })
  return (
    <Hint label={label}>
      <span className="rail-tabcount" role="img" aria-label={label}>
        <TerminalWindowIcon size={16} aria-hidden />
        {count}
      </span>
    </Hint>
  )
}

function WorkspaceMail({ workspaceId }: { workspaceId: string }): JSX.Element | null {
  const root = useLayoutStore((s) => s.byWorkspace[workspaceId]?.root)
  return root ? <MailCount paneIds={paneIds(root)} /> : null
}

export function RowChips({
  workspaceId,
  chips,
}: {
  workspaceId: string
  chips: readonly ExtensionSidebarItem[]
}): JSX.Element {
  return (
    <div className="rail-chips">
      <TabCount workspaceId={workspaceId} />
      <WorkspaceMail workspaceId={workspaceId} />
      <LiveLine items={chips} workspaceId={workspaceId} />
    </div>
  )
}
