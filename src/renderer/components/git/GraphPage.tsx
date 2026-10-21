import { GitBranchIcon } from '@phosphor-icons/react'
import type { GitGraphData, GraphScope } from '@shared/boards/git'
import { useEffect, useMemo, useRef } from 'react'
import { useDict } from '@/lib/app/useDict'
import { branchLabel, buildGraphModel, indexOfKey, WORKTREE } from '@/lib/git/gitView'
import {
  type ChangeHandlers,
  ChangeSections,
  CountChips,
  type FolderState,
  Tracking,
} from './ChangeList'
import { CommitDetail, DetailHead } from './CommitDetail'
import { GitEmpty } from './GitEmpty'
import { GraphList } from './GraphList'
import { ScopeControl } from './ScopeControl'
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
          <span className="branch-name" title={branchLabel(data.branch, t.detached)}>
            {branchLabel(data.branch, t.detached)}
          </span>
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
