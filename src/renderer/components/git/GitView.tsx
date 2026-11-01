import { ArrowClockwiseIcon, XIcon } from '@phosphor-icons/react'
import type { JSX } from 'react'
import { IconButton } from '@/components/common/IconButton'
import { SectionTab, SectionTabsList } from '@/components/common/SectionTabs'
import { Tabs } from '@/components/ui/tabs'
import { fmt, useDict } from '@/lib/app/useDict'
import { failureText, trackingTitle } from '@/lib/git/gitView'
import type { GitPage } from '@/stores/files/gitViewStore'
import { BlamePage } from './BlamePage'
import { ChangesPage } from './ChangesPage'
import { GitEmpty } from './GitEmpty'
import { GraphPage } from './GraphPage'
import { ScopeControl } from './ScopeControl'
import './git.css'
import { type GitHome, useGitView } from './useGitView'

const NOT_A_REPO = 'not-a-repo'

export function GitView({
  workspaceId,
  paneId,
  home,
  active = true,
  onClose,
}: {
  workspaceId: string
  paneId: string
  home: GitHome
  active?: boolean
  onClose?: () => void
}): JSX.Element {
  const d = useDict()
  const t = d.git
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
  } = useGitView({ workspaceId, paneId, home, shown: active, t })

  const labels: Record<GitPage, string> = {
    changes: t.tabChanges,
    graph: t.tabGraph,
    blame: t.tabBlame,
  }
  const pages: GitPage[] =
    home === 'dock' ? ['changes'] : blameFile || page === 'blame' ? ['graph', 'blame'] : ['graph']
  const shown = loaded?.page === page ? loaded : null
  const branch = shown && shown.page !== 'blame' ? shown.data.branch : null
  const refreshLabel = branch ? `${t.refresh} · ${trackingTitle(t, branch)}` : t.refresh

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
          {shown?.page === 'graph' ? (
            <ScopeControl data={shown.data} onScope={(scope) => void changeScope(scope)} />
          ) : null}
          <IconButton
            icon={ArrowClockwiseIcon}
            label={refreshLabel}
            className="refresh"
            onClick={() => void refresh()}
          />
          {onClose ? (
            <IconButton
              icon={XIcon}
              label={fmt(d.extensions.closePanel, { name: t.title })}
              data-panel-close=""
              onClick={onClose}
            />
          ) : null}
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
            onOpenFile={openCommitFile}
          />
        ) : (
          <BlamePage data={shown.data} />
        )}
      </div>
    </div>
  )
}
