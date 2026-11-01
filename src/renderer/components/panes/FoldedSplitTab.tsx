import { GridFourIcon } from '@phosphor-icons/react'
import type { AttentionState } from '@shared/attention/attention'
import type { JSX } from 'react'
import { Hint } from '@/components/common/Hint'
import { fmt, useDict } from '@/lib/app/useDict'
import { tabMark } from '@/lib/attention/attention'
import { allPanes } from '@/lib/layout/tree'
import type { SplitNode } from '@/lib/layout/types'
import { cn } from '@/lib/utils'
import { useAttentionStore } from '@/stores/agents/attentionStore'
import { closeSplitTabOnMiddleClick, focusPane, tabDragProps } from './SplitTab'

const COUNTED = ['waiting', 'error', 'working', 'done'] as const

const MARK_ORDER = ['waiting', 'error', 'done', 'unread'] as const

function useFoldedAttention(tab: SplitNode) {
  const states = useAttentionStore((s) =>
    allPanes(tab)
      .map((p) => s.byPane[p.id]?.state ?? 'none')
      .join(' '),
  )
  const marks = useAttentionStore((s) =>
    allPanes(tab)
      .map((p) => tabMark(s.byPane[p.id]) ?? '')
      .join(' '),
  )
  const counted = states.split(' ') as AttentionState[]
  const counts = COUNTED.map((state) => ({
    state,
    count: counted.filter((s) => s === state).length,
  })).filter((c) => c.count > 0)
  const present = marks.split(' ')
  const mark = MARK_ORDER.find((m) => present.includes(m)) ?? null
  return { counts, mark }
}

export function FoldedSplitTab({
  tab,
  dropMark,
  workspaceId,
  entering,
}: {
  tab: SplitNode
  dropMark: 'before' | 'after' | null
  workspaceId: string | null
  entering: boolean
}): JSX.Element {
  const d = useDict()
  const panes = allPanes(tab)
  const { counts, mark } = useFoldedAttention(tab)
  const name = tab.name ?? panes.map((p) => p.title).join(', ')
  const countText = {
    waiting: d.pane.foldedWaiting,
    working: d.pane.foldedWorking,
    error: d.pane.foldedFailed,
    done: d.pane.foldedDone,
  }
  const parts = [
    fmt(d.pane.foldedPanes, { count: panes.length }),
    ...counts.map((c) => fmt(countText[c.state], { count: c.count })),
  ]
  const open = panes.find((p) => !p.collapsed) ?? panes[0]
  return (
    <div
      className={cn(
        'pane-tab pane-split-tab folded',
        entering && 'motion-fade',
        dropMark && `drop-${dropMark}`,
      )}
      data-tab-id={tab.id}
      data-attention={mark ?? undefined}
      {...tabDragProps(tab.id, workspaceId, true)}
      {...closeSplitTabOnMiddleClick(tab.id, workspaceId)}
    >
      <Hint label={parts.join(', ')} side="bottom">
        <button
          type="button"
          role="tab"
          aria-selected={false}
          aria-expanded={false}
          aria-label={fmt(d.pane.foldedSplitTab, { name, summary: parts.join(', ') })}
          className="split-tab-fold-main"
          onClick={() => focusPane(open.id)}
        >
          <GridFourIcon size={16} className="pane-kind" aria-hidden />
          {mark ? <span className="pane-attn-mark" aria-hidden /> : null}
          <span className="split-tab-name">{name}</span>
          <span className="split-tab-fold-count text-ui-xs">{panes.length}</span>
        </button>
      </Hint>
    </div>
  )
}
