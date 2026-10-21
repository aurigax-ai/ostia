import { useMemo } from 'react'
import { Hint } from '@/components/common/Hint'
import { TextLink } from '@/components/common/TextLink'
import { useAgoText } from '@/lib/app/localeFormat'
import { useDict } from '@/lib/app/useDict'
import { useNow } from '@/lib/app/useNow'
import { revealPane } from '@/lib/attention/workspaceActivity'
import { type NeedsYouItem, type PaneWhere, paneWhere, sourceWhere } from '@/lib/sidebar/dashboard'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { ApprovalCard } from './ApprovalCard'
import { QuestionCard } from './QuestionCard'

export function useWhere(): (item: NeedsYouItem) => PaneWhere | null {
  const workspaces = useWorkspacesStore((s) => s.workspaces)
  const layouts = useLayoutStore((s) => s.byWorkspace)
  return useMemo(
    () => (item) =>
      item.kind === 'question' && item.question.source
        ? sourceWhere(item.question.source, workspaces)
        : paneWhere(itemPane(item), workspaces, layouts),
    [workspaces, layouts],
  )
}

function itemPane(item: NeedsYouItem): string {
  return item.kind === 'question' ? item.question.paneId : item.approval.paneId
}

const AGO_TICK_MS = 30_000

export function CardMeta({
  pane,
  at,
  onShow,
}: {
  pane: string
  at: number
  onShow?: () => void
}): JSX.Element {
  const d = useDict()
  const now = useNow(AGO_TICK_MS)
  const ago = useAgoText()
  return (
    <div className="flex min-w-0 items-center gap-2 text-fg-muted text-ui-xs">
      <span className="truncate font-medium text-fg">{pane}</span>
      <time dateTime={new Date(at).toISOString()} className="tabular-nums">
        {ago(now - at)}
      </time>
      {onShow ? (
        <TextLink size="xs" className="ml-auto h-auto p-0 text-ui-xs" onClick={onShow}>
          {d.dashboard.goToPane}
        </TextLink>
      ) : null}
    </div>
  )
}

export function NeedsYouCard({
  item,
  where,
  compact = false,
  onShowPane,
}: {
  item: NeedsYouItem
  where: PaneWhere | null
  compact?: boolean
  onShowPane?: () => void
}): JSX.Element {
  const d = useDict()
  if (item.kind === 'question') {
    return (
      <QuestionCard question={item.question} where={where} sent={item.sent} compact={compact} />
    )
  }
  const closed = d.attention.closedPane
  return (
    <ApprovalCard
      request={item.approval}
      paneTitle={where?.pane ?? closed}
      lead={
        compact ? (
          <CardMeta
            pane={where?.pane ?? closed}
            at={item.approval.at}
            onShow={where ? onShowPane : undefined}
          />
        ) : where ? (
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-fg-muted text-ui-xs">
            <span className="truncate font-medium text-fg">{where.workspace}</span>
            <Hint label={where.path}>
              <span className="truncate font-mono">{where.shortPath}</span>
            </Hint>
            <TextLink
              size="xs"
              className="ml-auto h-auto p-0 text-ui-xs"
              onClick={() => revealPane(item.approval.paneId)}
            >
              {d.dashboard.goToPane}
            </TextLink>
          </div>
        ) : null
      }
    />
  )
}
