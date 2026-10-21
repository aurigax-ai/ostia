import type { GitGraphData } from '@shared/boards/git'
import { useEffect, useMemo, useRef } from 'react'
import { useDict } from '@/lib/app/useDict'
import { buildGraphModel, indexOfKey, WORKTREE } from '@/lib/git/gitView'
import { type ChangeHandlers, ChangeSections, CountChips, type FolderState } from './ChangeList'
import { CommitDetail, DetailHead } from './CommitDetail'
import { GitEmpty } from './GitEmpty'
import { GraphList } from './GraphList'
import { SplitPane } from './SplitPane'

const GRAPH_SPLIT = 'graph-details'
const GRAPH_LIST_FRACTION = 0.55
const GRAPH_MIN_LIST = 96
const DETAIL_MIN = 96

export function GraphPage({
  workspaceId,
  data,
  selected,
  loadingMore,
  folders,
  handlers,
  onSelect,
  onLoadMore,
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

  const scopeKey = JSON.stringify(data.scope)
  useEffect(() => {
    const list = scroller.current
    if (list && scopeKey) list.scrollTop = 0
  }, [scopeKey])

  return (
    <>
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
