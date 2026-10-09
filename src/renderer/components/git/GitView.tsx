import { IconButton } from '@/components/common/IconButton'
import { SectionTab, SectionTabsList } from '@/components/common/SectionTabs'
import { GRAPH_PAGE, failureText, shortSha } from '@/lib/git/gitView'
import { useCoreWatch } from '@/lib/workspaces/coreWatch'
import { ArrowClockwiseIcon } from '@phosphor-icons/react'
import type {
  GitBlameData,
  GitChangesData,
  GitFailure,
  GitGraphData,
  GitReply,
  GraphScope,
} from '@shared/boards/git'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fmt, useDict } from '../../i18n/useDict'
import { type GitPage, useGitViewStore } from '../../stores/gitViewStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { Tabs } from '../ui/tabs'
import { BlamePage } from './BlamePage'
import type { ChangeHandlers, FolderState } from './ChangeList'
import { ChangesPage } from './ChangesPage'
import { GitEmpty } from './GitEmpty'
import { GraphPage } from './GraphPage'
import './git.css'

type Loaded =
  | { page: 'changes'; data: GitChangesData }
  | { page: 'graph'; data: GitGraphData }
  | { page: 'blame'; data: GitBlameData }

interface Banner {
  text: string
  tone: 'error' | 'ok'
}

const NOT_A_REPO = 'not-a-repo'
const CANCELLED = 'cancelled'
const NO_FOLDERS: ReadonlySet<string> = new Set()

async function fetchPage(
  workspaceId: string,
  page: GitPage,
  blameFile: string,
  limit: number,
): Promise<GitFailure | Loaded> {
  const git = window.ostia.git
  if (page === 'blame') {
    const res = await git.blame(workspaceId, blameFile)
    return res.ok ? { page, data: res.data } : res
  }
  if (page === 'graph') {
    const res = await git.graph(workspaceId, limit)
    return res.ok ? { page, data: res.data } : res
  }
  const res = await git.changes(workspaceId)
  return res.ok ? { page, data: res.data } : res
}

export function GitView({
  workspaceId,
  paneId,
}: { workspaceId: string; paneId: string }): JSX.Element {
  const t = useDict().git
  const nav = useGitViewStore((s) => s.nav[paneId])
  const [page, setPage] = useState<GitPage>(nav?.page ?? 'changes')
  const [blameFile, setBlameFile] = useState(nav?.file ?? '')
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [failure, setFailure] = useState<GitFailure | null>(null)
  const [banner, setBanner] = useState<Banner | null>(null)
  const [draft, setDraft] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [collapsed, setCollapsed] = useState(NO_FOLDERS)
  const alive = useRef(true)
  const request = useRef(0)
  const limit = useRef(GRAPH_PAGE)
  const shownCommits = useRef(0)
  const askedAt = useRef(-1)

  useCoreWatch('git', workspaceId)

  useEffect(() => {
    if (!nav) return
    setPage(nav.page)
    if (nav.page === 'blame') setBlameFile(nav.file ?? '')
    setBanner(null)
  }, [nav])

  const refresh = useCallback(async (): Promise<void> => {
    const seq = ++request.current
    if (page === 'blame' && !blameFile) {
      setFailure(null)
      return
    }
    const result = await fetchPage(workspaceId, page, blameFile, limit.current)
    if (!alive.current || seq !== request.current) return
    if ('ok' in result) {
      setFailure(result)
      return
    }
    if (result.page === 'graph') shownCommits.current = result.data.commits.length
    setFailure(null)
    setLoaded(result)
  }, [workspaceId, page, blameFile])

  const latestRefresh = useRef(refresh)
  latestRefresh.current = refresh

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    alive.current = true
    const again = (): void => void latestRefresh.current()
    const off = window.ostia.git.onChanged(again)
    window.addEventListener('focus', again)
    return () => {
      alive.current = false
      off()
      window.removeEventListener('focus', again)
    }
  }, [])

  const act = useCallback(async (run: Promise<GitReply<unknown>>): Promise<void> => {
    const res = await run
    if (!alive.current) return
    setBanner(res.ok || res.error === CANCELLED ? null : { text: failureText(res), tone: 'error' })
    await latestRefresh.current()
  }, [])

  const commit = useCallback(async (): Promise<void> => {
    const res = await window.ostia.git.commit(workspaceId, draft)
    if (!alive.current) return
    if (res.ok) {
      setDraft('')
      setBanner({ text: fmt(t.committed, { sha: shortSha(res.data.sha) }), tone: 'ok' })
    } else {
      setBanner({ text: failureText(res), tone: 'error' })
    }
    await latestRefresh.current()
  }, [workspaceId, draft, t])

  const changeScope = useCallback(
    async (scope: GraphScope): Promise<void> => {
      limit.current = GRAPH_PAGE
      askedAt.current = -1
      setSelected(null)
      const res = await window.ostia.git.setScope(workspaceId, scope)
      if (!alive.current) return
      if (!res.ok) setBanner({ text: failureText(res), tone: 'error' })
      else if (scope.kind !== 'chosen') {
        useSettingsStore.getState().setGit({ graphScope: scope.kind })
      }
      await latestRefresh.current()
    },
    [workspaceId],
  )

  const loadMore = useCallback(async (): Promise<void> => {
    if (askedAt.current === shownCommits.current) return
    askedAt.current = shownCommits.current
    limit.current += GRAPH_PAGE
    setLoadingMore(true)
    await latestRefresh.current()
    if (alive.current) setLoadingMore(false)
  }, [])

  const handlers = useMemo<ChangeHandlers>(() => {
    const git = window.ostia.git
    return {
      open: (path, area) => void act(git.openChange(workspaceId, path, area)),
      stage: (req) => void act(git.stage(workspaceId, req)),
      unstage: (req) => void act(git.unstage(workspaceId, req)),
      discard: (req) => void act(git.discard(workspaceId, req)),
    }
  }, [workspaceId, act])

  const openCommitFile = useCallback(
    (sha: string, path: string): void =>
      void act(window.ostia.git.openCommitFile(workspaceId, sha, path)),
    [workspaceId, act],
  )

  const folders = useMemo<FolderState>(
    () => ({
      collapsed,
      setOpen: (key, open) =>
        setCollapsed((old) => {
          if (old.has(key) !== open) return old
          const next = new Set(old)
          if (open) next.delete(key)
          else next.add(key)
          return next
        }),
    }),
    [collapsed],
  )

  const choosePage = (next: GitPage): void => {
    if (next === page) return
    setBanner(null)
    setPage(next)
  }

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
