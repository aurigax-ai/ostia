import { IconButton } from '@/components/common/IconButton'
import { SectionTab, SectionTabsList } from '@/components/common/SectionTabs'
import { useDict } from '@/lib/app/useDict'
import { failureText } from '@/lib/git/gitView'
import type { GitPage } from '@/stores/files/gitViewStore'
import { ArrowClockwiseIcon } from '@phosphor-icons/react'
import { Tabs } from '../ui/tabs'
import { BlamePage } from './BlamePage'
import { ChangesPage } from './ChangesPage'
import { GitEmpty } from './GitEmpty'
import { GraphPage } from './GraphPage'
import './git.css'
import { useGitView } from './useGitView'

const NOT_A_REPO = 'not-a-repo'

export function GitView({
  workspaceId,
  paneId,
}: { workspaceId: string; paneId: string }): JSX.Element {
  const t = useDict().git
  const {
    page,
    blameFile,
    loaded,
    failure,
    banner,
    draft,
    setDraft,
    selected,
    setSelected,
    loadingMore,
    refresh,
    commit,
    changeScope,
    loadMore,
    handlers,
    openCommitFile,
    folders,
    choosePage,
  } = useGitView({ workspaceId, paneId, t })

  const labels: Record<GitPage, string> = {
    changes: t.tabChanges,
    graph: t.tabGraph,
    blame: t.tabBlame,
  }
  const pages: GitPage[] =
    blameFile || page === 'blame' ? ['changes', 'graph', 'blame'] : ['changes', 'graph']
  const shown = loaded?.page === page ? loaded : null

  return (
    <div className="git-surface" data-page={page}>
      <Tabs
        value={page}
        onValueChange={(value) => choosePage(value as GitPage)}
        className="tabs gap-0 data-horizontal:flex-row"
      >
        <SectionTabsList className="w-auto flex-1">
          {pages.map((p) => (
            <SectionTab key={p} value={p} data-key={`tab-${p}`}>
              {labels[p]}
            </SectionTab>
          ))}
        </SectionTabsList>
        <span className="tabs-end">
          <IconButton
            icon={ArrowClockwiseIcon}
            label={t.refresh}
            className="refresh"
            onClick={() => void refresh()}
          />
        </span>
      </Tabs>
      {banner ? (
        <div
          className={`banner ${banner.tone}`}
          role={banner.tone === 'error' ? 'alert' : 'status'}
        >
          {banner.text}
        </div>
      ) : null}
      <div className="page">
        {failure ? (
          failure.error === NOT_A_REPO ? (
            <GitEmpty title={t.notRepo} hint={t.notRepoHint} />
          ) : (
            <GitEmpty title={failureText(failure)} tone="error" />
          )
        ) : page === 'blame' && !blameFile ? (
          <GitEmpty title={t.noBlameFile} />
        ) : !shown ? (
          <output className="loading muted">{t.loading}</output>
        ) : shown.page === 'changes' ? (
          <ChangesPage
            data={shown.data}
            draft={draft}
            onDraft={setDraft}
            onCommit={() => void commit()}
            folders={folders}
            handlers={handlers}
          />
        ) : shown.page === 'graph' ? (
          <GraphPage
            workspaceId={workspaceId}
            data={shown.data}
            selected={selected}
            loadingMore={loadingMore}
            folders={folders}
            handlers={handlers}
            onSelect={setSelected}
            onLoadMore={loadMore}
            onScope={(scope) => void changeScope(scope)}
            onOpenFile={openCommitFile}
          />
        ) : (
          <BlamePage data={shown.data} />
        )}
      </div>
    </div>
  )
}
