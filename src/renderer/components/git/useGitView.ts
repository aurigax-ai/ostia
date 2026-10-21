import type { Dict } from '@shared/app/dict'
import type {
  GitBlameData,
  GitChangesData,
  GitFailure,
  GitGraphData,
  GitReply,
  GraphScope,
} from '@shared/boards/git'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fmt } from '@/lib/app/useDict'
import { failureText, GRAPH_PAGE, shortSha } from '@/lib/git/gitView'
import { useSurfaceFocus } from '@/lib/panes/paneFocus'
import { useCoreWatch } from '@/lib/workspaces/coreWatch'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { type GitPage, useGitViewStore } from '@/stores/files/gitViewStore'
import type { ChangeHandlers, FolderState } from './ChangeList'

type Loaded =
  | { page: 'changes'; data: GitChangesData }
  | { page: 'graph'; data: GitGraphData }
  | { page: 'blame'; data: GitBlameData }

interface Banner {
  text: string
  tone: 'error' | 'ok'
}

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

function useGitFolders(): FolderState {
  const [collapsed, setCollapsed] = useState(NO_FOLDERS)
  return useMemo<FolderState>(
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
}

function useGitHandlers(
  workspaceId: string,
  act: (run: Promise<GitReply<unknown>>) => Promise<void>,
) {
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

  return { handlers, openCommitFile }
}

export type GitHome = 'dock' | 'pane'

export function useGitView({
  workspaceId,
  paneId,
  home,
  shown,
  t,
}: {
  workspaceId: string
  paneId: string
  home: GitHome
  shown: boolean
  t: Dict['git']
}) {
  useSurfaceFocus(paneId, null)
  const nav = useGitViewStore((s) => s.nav[paneId])
  const [page, setPage] = useState<GitPage>(nav?.page ?? (home === 'dock' ? 'changes' : 'graph'))
  const [blameFile, setBlameFile] = useState(nav?.file ?? '')
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [failure, setFailure] = useState<GitFailure | null>(null)
  const [banner, setBanner] = useState<Banner | null>(null)
  const [draft, setDraft] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const folders = useGitFolders()
  const alive = useRef(true)
  const request = useRef(0)
  const limit = useRef(GRAPH_PAGE)
  const shownCommits = useRef(0)
  const askedAt = useRef(-1)

  useCoreWatch('git', workspaceId, shown)

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
    if (shown) void refresh()
  }, [refresh, shown])

  useEffect(() => {
    alive.current = true
    if (!shown) return
    const again = (): void => void latestRefresh.current()
    const off = window.ostia.git.onChanged(again)
    window.addEventListener('focus', again)
    return () => {
      alive.current = false
      off()
      window.removeEventListener('focus', again)
    }
  }, [shown])

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

  const { handlers, openCommitFile } = useGitHandlers(workspaceId, act)

  const choosePage = (next: GitPage): void => {
    if (next === page) return
    setBanner(null)
    setPage(next)
  }

  return {
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
  }
}
