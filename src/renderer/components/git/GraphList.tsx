import { CloudIcon, GitBranchIcon, TagIcon } from '@phosphor-icons/react'
import type { CommitRef, GitGraphData, StatusSummary } from '@shared/boards/git'
import {
  type CSSProperties,
  type JSX,
  type KeyboardEvent,
  memo,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useState,
} from 'react'
import { useDict } from '@/lib/app/useDict'
import { useElementSize } from '@/lib/app/useElementSize'
import type { GraphRow } from '@/lib/git/gitGraph'
import {
  absoluteTime,
  edgePath,
  entryKey,
  type GraphEntry,
  type GraphModel,
  indexOfKey,
  LANE_COLORS,
  LOAD_MORE_MARGIN,
  laneX,
  ROW_HEIGHT,
  relativeTime,
  SELECTION_KEYS,
  scrollTopToShow,
  selectionTarget,
  shortSha,
  visibleRange,
} from '@/lib/git/gitView'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { CountChips } from './ChangeList'

function Lanes({
  entry,
  row,
  isHead,
  width,
}: {
  entry: GraphEntry
  row: GraphRow
  isHead: boolean
  width: number
}): JSX.Element {
  const mid = ROW_HEIGHT / 2
  const cx = laneX(row.lane)
  const lane = `lane-${row.color % LANE_COLORS}`
  return (
    <svg
      className="lanes"
      width={width}
      height={ROW_HEIGHT}
      viewBox={`0 0 ${width} ${ROW_HEIGHT}`}
      aria-hidden="true"
    >
      {row.top.map((e) => (
        <path
          key={`t${e.from}-${e.to}`}
          d={edgePath(e, 0, mid)}
          className={`edge lane-${e.color % LANE_COLORS}${e.pending ? ' pending' : ''}`}
        />
      ))}
      {row.bottom.map((e) => (
        <path
          key={`b${e.from}-${e.to}`}
          d={edgePath(e, mid, ROW_HEIGHT)}
          className={`edge lane-${e.color % LANE_COLORS}${e.pending ? ' pending' : ''}`}
        />
      ))}
      {entry.kind === 'worktree' ? (
        <circle cx={cx} cy={mid} r={4.5} className={`node pending ${lane}`} />
      ) : isHead ? (
        <g>
          <circle cx={cx} cy={mid} r={5} className={`node ring ${lane}`} />
          <circle cx={cx} cy={mid} r={2} className={`node ${lane}`} />
        </g>
      ) : entry.commit.parents.length > 1 ? (
        <circle cx={cx} cy={mid} r={3} className={`node merge ${lane}`} />
      ) : (
        <circle cx={cx} cy={mid} r={4} className={`node ${lane}`} />
      )}
    </svg>
  )
}

function RefBadge({ commitRef, color }: { commitRef: CommitRef; color: number }): JSX.Element {
  const t = useDict().git
  const Glyph =
    commitRef.kind === 'tag' ? TagIcon : commitRef.kind === 'remote' ? CloudIcon : GitBranchIcon
  const laned = commitRef.current || commitRef.kind === 'head'
  return (
    <span
      className={`ref ref-${commitRef.kind}${commitRef.current ? ' ref-current' : ''}${laned ? ` lane-${color % LANE_COLORS}` : ''}`}
      title={commitRef.current ? `${t.head} → ${commitRef.name}` : commitRef.name}
    >
      <Glyph />
      <span className="ref-name">{commitRef.name}</span>
    </span>
  )
}

const GraphRowView = memo(function GraphRowView({
  id,
  entry,
  row,
  index,
  width,
  selected,
  isHead,
  counts,
  locale,
  now,
  onSelect,
}: {
  id: string
  entry: GraphEntry
  row: GraphRow
  index: number
  width: number
  selected: boolean
  isHead: boolean
  counts: StatusSummary
  locale: string
  now: number
  onSelect: (key: string) => void
}): JSX.Element {
  const t = useDict().git
  const key = entryKey(entry)
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the listbox handles the keys for its options
    // biome-ignore lint/a11y/useFocusableInteractive: the listbox keeps focus and names the active option
    <div
      id={id}
      className={`graph-row${selected ? ' selected' : ''}${entry.kind === 'worktree' ? ' worktree' : ''}`}
      role="option"
      data-sha={key}
      aria-selected={selected}
      style={{ transform: `translateY(${index * ROW_HEIGHT}px)` }}
      onClick={() => onSelect(key)}
    >
      <span className="lanes-cell">
        <Lanes entry={entry} row={row} isHead={isHead} width={width} />
      </span>
      {entry.kind === 'worktree' ? (
        <>
          <span className="subject worktree-title">{t.worktree}</span>
          <CountChips counts={counts} />
        </>
      ) : (
        <>
          <span className="refs">
            {isHead && !entry.commit.refs.some((r) => r.current || r.kind === 'head') ? (
              <RefBadge commitRef={{ kind: 'head', name: t.head }} color={row.color} />
            ) : null}
            {entry.commit.refs.map((r) => (
              <RefBadge key={`${r.kind}:${r.name}`} commitRef={r} color={row.color} />
            ))}
          </span>
          <span className="subject" title={entry.commit.subject}>
            {entry.commit.subject}
          </span>
          <span className="who muted">{entry.commit.author}</span>
          <span className="when muted" title={absoluteTime(entry.commit.time, locale)}>
            {relativeTime(entry.commit.time, now, locale)}
          </span>
          <span className="sha muted">{shortSha(entry.commit.sha)}</span>
        </>
      )}
    </div>
  )
})

export function GraphList({
  data,
  model,
  now,
  selected,
  loadingMore,
  onSelect,
  onLoadMore,
  scroller,
}: {
  data: GitGraphData
  model: GraphModel
  now: number
  selected: string | null
  loadingMore: boolean
  onSelect: (key: string | null) => void
  onLoadMore: () => void
  scroller: RefObject<HTMLDivElement | null>
}): JSX.Element {
  const t = useDict().git
  const ids = useId()
  const locale = useSettingsStore((s) => s.locale)
  const [topRow, setTopRow] = useState(0)
  const { height: viewport } = useElementSize(scroller)
  const count = model.entries.length
  const { first, last } = visibleRange(topRow * ROW_HEIGHT, viewport, count)
  const nearEnd = last >= count - LOAD_MORE_MARGIN

  useEffect(() => {
    if (data.more && !loadingMore && nearEnd) onLoadMore()
  }, [data, loadingMore, nearEnd, onLoadMore])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape' && selected) {
      e.preventDefault()
      onSelect(null)
      return
    }
    if (!SELECTION_KEYS.includes(e.key) || count === 0) return
    e.preventDefault()
    const el = e.currentTarget
    const next = selectionTarget(e.key, indexOfKey(model, selected), count, el.clientHeight)
    el.scrollTop = scrollTopToShow(next, el.scrollTop, el.clientHeight)
    onSelect(entryKey(model.entries[next]))
  }

  const rows: ReactNode[] = []
  for (let i = first; i < last; i++) {
    const entry = model.entries[i]
    const key = entryKey(entry)
    rows.push(
      <GraphRowView
        key={key}
        id={`${ids}-row-${key}`}
        entry={entry}
        row={model.rows[i]}
        index={i}
        width={model.width}
        selected={key === selected}
        isHead={entry.kind === 'commit' && entry.commit.sha === data.branch.oid}
        counts={data.counts}
        locale={locale}
        now={now}
        onSelect={onSelect}
      />,
    )
  }

  return (
    <div
      ref={scroller}
      className="graph-scroll"
      role="listbox"
      tabIndex={0}
      aria-label={t.graph}
      aria-activedescendant={selected ? `${ids}-row-${selected}` : undefined}
      style={{ '--graph-width': `${model.width}px` } as CSSProperties}
      onKeyDown={onKeyDown}
      onScroll={(e) => setTopRow(Math.floor(e.currentTarget.scrollTop / ROW_HEIGHT))}
    >
      <div
        className="graph-canvas"
        style={{ height: (count + (loadingMore ? 1 : 0)) * ROW_HEIGHT }}
      >
        {rows}
        {loadingMore ? (
          <output
            className="graph-more muted"
            style={{ transform: `translateY(${count * ROW_HEIGHT}px)` }}
          >
            {t.loadingMore}
          </output>
        ) : null}
      </div>
    </div>
  )
}
