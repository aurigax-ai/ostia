import { IconButton } from '@/components/common/IconButton'
import type { GraphRow } from '@/lib/git/gitGraph'
import {
  type GraphEntry,
  type GraphModel,
  LANE_COLORS,
  LOAD_MORE_MARGIN,
  ROW_HEIGHT,
  SELECTION_KEYS,
  WORKTREE,
  absoluteTime,
  branchLabel,
  buildGraphModel,
  edgePath,
  entryKey,
  failureText,
  indexOfKey,
  laneX,
  relativeTime,
  scrollTopToShow,
  selectionTarget,
  shortSha,
  visibleRange,
} from '@/lib/git/gitView'
import { CloudIcon, GitBranchIcon, TagIcon, XIcon } from '@phosphor-icons/react'
import type {
  CommitRef,
  GitCommitFilesData,
  GitFailure,
  GitGraphData,
  GraphCommit,
  GraphScope,
  StatusSummary,
} from '@shared/boards/git'
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  memo,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useDict } from '../../i18n/useDict'
import { useSettingsStore } from '../../stores/settingsStore'
import {
  type ChangeHandlers,
  ChangeSections,
  CountChips,
  FileList,
  type FolderState,
  Tracking,
  ViewToggle,
} from './ChangeList'
import { GitEmpty } from './GitEmpty'
import { ScopeControl } from './ScopeControl'
import { SplitPane } from './SplitPane'

export const GRAPH_SPLIT = 'graph-details'
export const DETAIL_DELAY_MS = 120
const MAX_CACHED_DETAILS = 200
const GRAPH_LIST_FRACTION = 0.55
const GRAPH_MIN_LIST = 96
const DETAIL_MIN = 96

type Detail = GitCommitFilesData | GitFailure

function useCommitFiles(workspaceId: string, sha: string | null): Detail | null {
  const cache = useRef(new Map<string, Detail>())
  const [, setLoads] = useState(0)
  useEffect(() => {
    if (!sha || cache.current.has(sha)) return
    let alive = true
    const timer = setTimeout(() => {
      void window.ostia.git.commitFiles(workspaceId, sha).then((res) => {
        const details = cache.current
        details.set(sha, res.ok ? res.data : res)
        for (const oldest of details.keys()) {
          if (details.size <= MAX_CACHED_DETAILS) break
          details.delete(oldest)
        }
        if (alive) setLoads((n) => n + 1)
      })
    }, DETAIL_DELAY_MS)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [workspaceId, sha])
  return sha ? (cache.current.get(sha) ?? null) : null
}

function Lanes({
  entry,
  row,
  isHead,
  width,
}: { entry: GraphEntry; row: GraphRow; isHead: boolean; width: number }): JSX.Element {
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
      // biome-ignore lint/a11y/useSemanticElements: a virtualized row with lanes and badges, not a select option
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

function GraphList({
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
  scroller: RefObject<HTMLDivElement>
}): JSX.Element {
  const t = useDict().git
  const ids = useId()
  const locale = useSettingsStore((s) => s.locale)
  const [topRow, setTopRow] = useState(0)
  const [viewport, setViewport] = useState(0)
  const count = model.entries.length
  const { first, last } = visibleRange(topRow * ROW_HEIGHT, viewport, count)
  const nearEnd = last >= count - LOAD_MORE_MARGIN

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const observer = new ResizeObserver(() => setViewport(el.clientHeight))
    observer.observe(el)
    setViewport(el.clientHeight)
    return () => observer.disconnect()
  }, [scroller])

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
      // biome-ignore lint/a11y/useSemanticElements: a virtualized commit list, not a form select
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

function DetailHead({
  title,
  meta,
  onClose,
}: { title: string; meta: ReactNode; onClose: () => void }): JSX.Element {
  const t = useDict().git
  return (
    <header className="detail-head">
      <div className="detail-title">
        <span className="detail-subject">{title}</span>
        <div className="detail-meta muted">{meta}</div>
      </div>
      <ViewToggle />
      <IconButton icon={XIcon} label={t.closeDetails} onClick={onClose} />
    </header>
  )
}

function CommitDetail({
  workspaceId,
  commit,
  model,
  now,
  folders,
  onSelect,
  onOpenFile,
}: {
  workspaceId: string
  commit: GraphCommit
  model: GraphModel
  now: number
  folders: FolderState
  onSelect: (key: string | null) => void
  onOpenFile: (sha: string, path: string) => void
}): JSX.Element {
  const t = useDict().git
  const locale = useSettingsStore((s) => s.locale)
  const detail = useCommitFiles(workspaceId, commit.sha)
  return (
    <section className="detail" aria-label={commit.subject} data-sha={commit.sha}>
      <DetailHead
        title={commit.subject}
        onClose={() => onSelect(null)}
        meta={
          <>
            <span className="sha">{commit.sha.slice(0, 10)}</span>
            <span>{commit.author}</span>
            <span title={absoluteTime(commit.time, locale)}>
              {relativeTime(commit.time, now, locale)}
            </span>
            {commit.parents.length > 1 ? <span>{t.merge}</span> : null}
            {commit.parents.length > 0 ? (
              <span className="parents">
                {`${t.parents}: `}
                {commit.parents.map((p) => (
                  <button
                    key={p}
                    type="button"
                    className="link sha"
                    aria-label={`${t.parents}: ${shortSha(p)}`}
                    disabled={indexOfKey(model, p) < 0}
                    onClick={() => onSelect(p)}
                  >
                    {shortSha(p)}
                  </button>
                ))}
              </span>
            ) : null}
          </>
        }
      />
      {detail === null ? (
        <output className="muted detail-status">{t.loading}</output>
      ) : 'ok' in detail ? (
        <div className="error detail-status" role="alert">
          {failureText(detail)}
        </div>
      ) : detail.files.length === 0 ? (
        <div className="muted detail-status">{t.noFiles}</div>
      ) : (
        <FileList
          items={detail.files}
          folders={folders}
          scopeKey={`c-${commit.sha}`}
          label={(f) => `${t.openDiff}: ${f.path} (${shortSha(commit.sha)})`}
          onOpen={(f) => onOpenFile(commit.sha, f.path)}
        />
      )}
    </section>
  )
}

export function GraphPage({
  workspaceId,
  data,
  selected,
  loadingMore,
  folders,
  handlers,
  onSelect,
  onLoadMore,
  onScope,
  onOpenFile,
}: {
  workspaceId: string
  data: GitGraphData
  selected: string | null
  loadingMore: boolean
  folders: FolderState
  handlers: ChangeHandlers
  onSelect: (key: string | null) => void
  onLoadMore: () => void
  onScope: (scope: GraphScope) => void
  onOpenFile: (sha: string, path: string) => void
}): JSX.Element {
  const t = useDict().git
  const scroller = useRef<HTMLDivElement>(null)
  const { model, now } = useMemo(() => ({ model: buildGraphModel(data), now: Date.now() }), [data])
  const at = indexOfKey(model, selected)
  const entry = at < 0 ? null : model.entries[at]
  const gone = selected !== null && at < 0

  useEffect(() => {
    if (gone) onSelect(null)
  }, [gone, onSelect])

  const changeScope = (scope: GraphScope): void => {
    if (scroller.current) scroller.current.scrollTop = 0
    onScope(scope)
  }

  return (
    <>
      <div className="graph-toolbar">
        <ScopeControl data={data} onScope={changeScope} />
        <span className="toolbar-branch">
          <GitBranchIcon />
          {branchLabel(data.branch, t.detached)}
        </span>
        <Tracking branch={data.branch} />
      </div>
      {model.entries.length === 0 ? (
        <GitEmpty title={t.noCommits} />
      ) : (
        <SplitPane
          splitKey={GRAPH_SPLIT}
          label={t.resizeDetails}
          firstClassName="graph-list-pane"
          secondClassName="detail-pane"
          defaultFraction={GRAPH_LIST_FRACTION}
          minFirst={GRAPH_MIN_LIST}
          minSecond={DETAIL_MIN}
          collapseSecond
          first={
            <GraphList
              data={data}
              model={model}
              now={now}
              selected={entry ? selected : null}
              loadingMore={loadingMore}
              onSelect={onSelect}
              onLoadMore={onLoadMore}
              scroller={scroller}
            />
          }
          second={
            !entry ? null : entry.kind === 'worktree' ? (
              <section className="detail" aria-label={t.worktree} data-sha={WORKTREE}>
                <DetailHead
                  title={t.worktree}
                  meta={<CountChips counts={data.counts} />}
                  onClose={() => onSelect(null)}
                />
                <ChangeSections data={data} keyPrefix="wt-" folders={folders} handlers={handlers} />
              </section>
            ) : (
              <CommitDetail
                workspaceId={workspaceId}
                commit={entry.commit}
                model={model}
                now={now}
                folders={folders}
                onSelect={onSelect}
                onOpenFile={onOpenFile}
              />
            )
          }
        />
      )}
    </>
  )
}
