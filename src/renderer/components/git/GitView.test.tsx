import { PANEL_SIZES_KEY, PANEL_SIZES_WRITE_DELAY_MS } from '@/lib/panes/panelSizes'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useGitViewStore } from '@/stores/files/gitViewStore'
import type {
  BranchRef,
  FileChange,
  GitBlameData,
  GitChangesData,
  GitCommitFilesData,
  GitGraphData,
  GraphCommit,
} from '@shared/boards/git'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { renderSettled } from '../../../../test/render'
import { GitView } from './GitView'

const ROOT = '/repo'

const CHANGES: FileChange[] = [
  { path: 'both.txt', area: 'conflicted', code: 'U' },
  { path: 'src/staged.ts', area: 'staged', code: 'A' },
  { path: 'notes.txt', area: 'unstaged', code: 'M' },
  { path: 'src/deep/new.ts', area: 'untracked', code: '?' },
]

function changesData(changes: FileChange[] = CHANGES): GitChangesData {
  const count = (area: string): number => changes.filter((c) => c.area === area).length
  return {
    root: ROOT,
    branch: { oid: 'a'.repeat(40), head: 'main', upstream: 'origin/main', ahead: 2, behind: 1 },
    counts: {
      added: 0,
      changed: changes.length,
      staged: count('staged'),
      unstaged: count('unstaged'),
      untracked: count('untracked'),
      conflicted: count('conflicted'),
    },
    changes,
  }
}

function commitOf(sha: string, subject: string, parents: string[]): GraphCommit {
  return {
    sha,
    subject,
    parents,
    author: 'Ada',
    email: 'ada@example.com',
    time: 1_700_000_000,
    refs: [],
  }
}

const HEAD = 'a'.repeat(40)
const SECOND = 'b'.repeat(40)
const FIRST = 'c'.repeat(40)

const BRANCHES: BranchRef[] = [
  { ref: 'refs/heads/main', name: 'main', remote: false, current: true, sha: HEAD, time: 3 },
  { ref: 'refs/heads/side', name: 'side', remote: false, current: false, sha: SECOND, time: 2 },
  {
    ref: 'refs/remotes/origin/main',
    name: 'origin/main',
    remote: true,
    current: false,
    sha: FIRST,
    time: 1,
  },
]

function graphData(patch: Partial<GitGraphData> = {}): GitGraphData {
  return {
    ...changesData(),
    branches: BRANCHES,
    scope: { kind: 'current' },
    includesHead: true,
    commits: [
      {
        ...commitOf(HEAD, 'merge feature into main', [SECOND, FIRST]),
        refs: [
          { kind: 'branch', name: 'main', current: true },
          { kind: 'tag', name: 'v1.0' },
        ],
      },
      commitOf(SECOND, 'add feature', [FIRST]),
      commitOf(FIRST, 'root commit', []),
    ],
    more: false,
    ...patch,
  }
}

const COMMIT_FILES: GitCommitFilesData = {
  root: ROOT,
  commit: commitOf(SECOND, 'add feature', [FIRST]),
  parent: FIRST,
  files: [
    { path: 'feature.txt', code: 'A' },
    { path: 'src/old.ts', code: 'D' },
  ],
}

const BLAME: GitBlameData = {
  root: ROOT,
  path: 'src/a.ts',
  lines: [
    {
      line: 1,
      sha: SECOND,
      author: 'Ada',
      time: 1_700_000_000,
      summary: 'add feature',
      text: 'one',
    },
    {
      line: 2,
      sha: SECOND,
      author: 'Ada',
      time: 1_700_000_000,
      summary: 'add feature',
      text: 'two',
    },
    { line: 3, sha: '0'.repeat(40), author: 'You', time: 0, summary: '', text: 'three' },
  ],
}

const git = (): typeof window.ostia.git => window.ostia.git
const root = (): HTMLElement => document.querySelector('.git-surface') as HTMLElement
const fileRow = (path: string): HTMLElement =>
  root().querySelector(`button.change[data-path="${path}"]`) as HTMLElement
const graphRow = (sha: string): HTMLElement =>
  root().querySelector(`.graph-row[data-sha="${sha}"]`) as HTMLElement

function showChanges(data: GitChangesData = changesData()): void {
  vi.mocked(git().changes).mockResolvedValue({ ok: true, data })
}

function showGraph(data: GitGraphData = graphData()): void {
  vi.mocked(git().graph).mockResolvedValue({ ok: true, data })
}

async function openGraph(): Promise<void> {
  await act(async () => useGitViewStore.getState().navigate('p1', 'graph'))
  await waitFor(() => expect(root().dataset.page).toBe('graph'))
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    fireEvent.click(el)
  })
}

describe('GitView', () => {
  let settings: ReturnType<typeof useSettingsStore.getState>
  beforeAll(() => {
    settings = useSettingsStore.getState()
  })
  afterEach(() => {
    cleanup()
    useSettingsStore.setState(settings, true)
    useGitViewStore.setState({ nav: {} })
    vi.useRealTimers()
  })

  describe('changes', () => {
    it('lists each kind of change under its own heading with the branch and tracking state', async () => {
      showChanges()
      await renderSettled(<GitView workspaceId="w1" paneId="p1" />)

      expect(root().dataset.page).toBe('changes')
      expect(git().changes).toHaveBeenCalledWith('w1')
      const areas = [...root().querySelectorAll('section.area')].map((s) =>
        s.getAttribute('aria-label'),
      )
      expect(areas).toEqual(['Conflicts', 'Staged', 'Changes', 'Untracked'])
      const staged = screen.getByRole('region', { name: 'Staged' })
      expect(within(staged).getByText('staged.ts')).toBeInTheDocument()
      expect(within(staged).getByText('src')).toBeInTheDocument()
      expect(root().querySelector('.branch')).toHaveTextContent('main')
      expect(root().querySelector('.tracking')).toHaveAttribute(
        'title',
        '2 to push, 1 to pull from origin/main',
      )
      expect(root().querySelector('.root')).toHaveTextContent(ROOT)
    })

    it('says there are no changes in a clean repository', async () => {
      showChanges(changesData([]))
      await renderSettled(<GitView workspaceId="w1" paneId="p1" />)

      expect(screen.getByText('No changes')).toBeInTheDocument()
      expect(root().querySelectorAll('section.area')).toHaveLength(0)
    })

    it('opens the diff of the clicked file', async () => {
      showChanges()
      await renderSettled(<GitView workspaceId="w1" paneId="p1" />)

      await click(fileRow('notes.txt'))

      expect(git().openChange).toHaveBeenCalledWith('w1', '/repo/notes.txt', 'unstaged')
    })

    it('stages, unstages and discards one file by its absolute path', async () => {
      showChanges()
      await renderSettled(<GitView workspaceId="w1" paneId="p1" />)

      await click(screen.getByRole('button', { name: 'Stage: notes.txt' }))
      await click(screen.getByRole('button', { name: 'Unstage: src/staged.ts' }))
      await click(screen.getByRole('button', { name: 'Discard changes: notes.txt' }))

      expect(git().stage).toHaveBeenCalledWith('w1', { paths: ['/repo/notes.txt'], all: false })
      expect(git().unstage).toHaveBeenCalledWith('w1', {
        paths: ['/repo/src/staged.ts'],
        all: false,
      })
      expect(git().discard).toHaveBeenCalledWith('w1', { paths: ['/repo/notes.txt'], all: false })
      expect(screen.queryByRole('button', { name: 'Discard changes: src/staged.ts' })).toBeNull()
    })

    it('acts on a whole area from its heading', async () => {
      showChanges()
      await renderSettled(<GitView workspaceId="w1" paneId="p1" />)

      await click(screen.getByRole('button', { name: 'Stage all: Changes' }))
      await click(screen.getByRole('button', { name: 'Unstage all' }))
      await click(screen.getByRole('button', { name: 'Discard all: Untracked' }))

      expect(git().stage).toHaveBeenCalledWith('w1', { paths: [], all: true })
      expect(git().unstage).toHaveBeenCalledWith('w1', { paths: [], all: true })
      expect(git().discard).toHaveBeenCalledWith('w1', { paths: [], all: true })
    })

    it('reloads the list after an action and shows why a failed one failed', async () => {
      showChanges()
      vi.mocked(git().stage).mockResolvedValue({
        ok: false,
        error: 'failed',
        message: 'index locked',
      })
      await renderSettled(<GitView workspaceId="w1" paneId="p1" />)
      expect(git().changes).toHaveBeenCalledTimes(1)

      await click(screen.getByRole('button', { name: 'Stage: notes.txt' }))

      expect(screen.getByRole('alert')).toHaveTextContent('index locked')
      expect(git().changes).toHaveBeenCalledTimes(2)
    })

    it('stays quiet when the human cancels a discard', async () => {
      showChanges()
      vi.mocked(git().discard).mockResolvedValue({
        ok: false,
        error: 'cancelled',
        message: 'Cancelled; nothing was changed.',
      })
      await renderSettled(<GitView workspaceId="w1" paneId="p1" />)

      await click(screen.getByRole('button', { name: 'Discard changes: notes.txt' }))

      expect(git().discard).toHaveBeenCalled()
      expect(root().querySelector('.banner')).toBeNull()
    })

    it('commits the typed message, clears the box and names the new commit', async () => {
      showChanges()
      vi.mocked(git().commit).mockResolvedValue({
        ok: true,
        data: { root: ROOT, sha: 'abc1234def5678' },
      })
      await renderSettled(<GitView workspaceId="w1" paneId="p1" />)
      const box = root().querySelector('.commit textarea.message') as HTMLTextAreaElement
      const submit = root().querySelector('.commit button.primary') as HTMLButtonElement
      expect(submit).toBeDisabled()

      fireEvent.change(box, { target: { value: 'first commit' } })
      expect(submit).toBeEnabled()
      await click(submit)

      expect(git().commit).toHaveBeenCalledWith('w1', 'first commit')
      expect(box.value).toBe('')
      expect(screen.getByRole('status')).toHaveTextContent('Committed abc1234')
    })

    it('commits on Ctrl+Enter, and only when something is staged', async () => {
      showChanges(changesData(CHANGES.filter((c) => c.area !== 'staged')))
      const view = await renderSettled(<GitView workspaceId="w1" paneId="p1" />)
      const box = (): HTMLTextAreaElement =>
        root().querySelector('textarea.message') as HTMLTextAreaElement
      fireEvent.change(box(), { target: { value: 'wip' } })

      fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true })
      expect(git().commit).not.toHaveBeenCalled()
      expect(root().querySelector('.commit button.primary')).toBeDisabled()

      view.unmount()
      showChanges()
      await renderSettled(<GitView workspaceId="w1" paneId="p1" />)
      fireEvent.change(box(), { target: { value: 'wip' } })
      fireEvent.keyDown(box(), { key: 'Enter' })
      expect(git().commit).not.toHaveBeenCalled()
      await act(async () => {
        fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true })
      })
      expect(git().commit).toHaveBeenCalledWith('w1', 'wip')
    })

    it('keeps the draft message, and the text typed without React events, across a refresh', async () => {
      showChanges()
      let changed = (): void => {}
      vi.mocked(git().onChanged).mockImplementation((cb) => {
        changed = cb
        return () => {}
      })
      await renderSettled(<GitView workspaceId="w1" paneId="p1" />)
      const box = root().querySelector('textarea.message') as HTMLTextAreaElement

      box.value = 'draft kept'
      await act(async () => {
        box.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await act(async () => changed())

      expect(git().changes).toHaveBeenCalledTimes(2)
      expect(root().querySelector('textarea.message')).toBe(box)
      expect(box.value).toBe('draft kept')
    })
  })

  describe('list and tree', () => {
    it('writes the chosen layout to the settings and groups files into folders', async () => {
      showChanges()
      await renderSettled(<GitView workspaceId="w1" paneId="p1" />)
      expect(root().querySelectorAll('button.folder')).toHaveLength(0)
      expect(screen.getByRole('button', { name: 'Flat list' })).toHaveAttribute(
        'aria-pressed',
        'true',
      )

      await click(screen.getByRole('button', { name: 'Folder tree' }))

      expect(useSettingsStore.getState().git.changesView).toBe('tree')
      expect(screen.getByRole('button', { name: 'Folder tree' })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
      const folders = [...root().querySelectorAll('button.folder')].map((b) =>
        b.getAttribute('data-folder'),
      )
      expect(folders).toEqual(['src', 'src/deep'])
    })

    it('stages a whole folder and hides its files when collapsed', async () => {
      useSettingsStore.getState().setGit({ changesView: 'tree' })
      showChanges()
      await renderSettled(<GitView workspaceId="w1" paneId="p1" />)

      await click(screen.getByRole('button', { name: 'Stage folder: src/deep' }))
      expect(git().stage).toHaveBeenCalledWith('w1', {
        paths: ['/repo/src/deep/new.ts'],
        all: false,
      })

      const folder = root().querySelector('button.folder[data-folder="src/deep"]') as HTMLElement
      expect(folder).toHaveAttribute('aria-expanded', 'true')
      await click(folder)
      expect(folder).toHaveAttribute('aria-expanded', 'false')
      expect(fileRow('src/deep/new.ts')).toBeNull()
      fireEvent.keyDown(folder, { key: 'ArrowRight' })
      expect(fileRow('src/deep/new.ts')).not.toBeNull()
    })

    it('puts the files of one folder under it in each area and follows a layout chosen in the settings', async () => {
      useSettingsStore.getState().setGit({ changesView: 'tree' })
      showChanges(
        changesData([
          { path: 'src/deep/new.txt', area: 'staged', code: 'A' },
          { path: 'src/deep/feature.txt', area: 'unstaged', code: 'M' },
        ]),
      )
      await renderSettled(<GitView workspaceId="w1" paneId="p1" />)
      const folders = (): string[] =>
        [...root().querySelectorAll('button.folder')].map(
          (b) =>
            `${b.querySelector('.name')?.textContent} ${b.querySelector('.folder-count')?.textContent}`,
        )
      expect(folders()).toEqual(['src/deep 1', 'src/deep 1'])

      act(() => useSettingsStore.getState().setGit({ changesView: 'list' }))

      expect(folders()).toEqual([])
      expect(fileRow('src/deep/feature.txt')).not.toBeNull()
      expect(screen.getByRole('button', { name: 'Flat list' })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
    })
  })

  describe('failures', () => {
    it('explains that the workspace is not inside a repository', async () => {
      await renderSettled(<GitView workspaceId="w1" paneId="p1" />)

      expect(screen.getByText('Not in a git repository')).toBeInTheDocument()
      expect(
        screen.getByText('Open a terminal inside a repository to see its changes and history.'),
      ).toBeInTheDocument()
      expect(screen.queryByRole('alert')).toBeNull()
    })

    it('shows any other failure as an error', async () => {
      vi.mocked(git().changes).mockResolvedValue({
        ok: false,
        error: 'git-failed',
        message: 'fatal: bad object',
      })
      await renderSettled(<GitView workspaceId="w1" paneId="p1" />)

      expect(screen.getByRole('alert')).toHaveTextContent('fatal: bad object')
    })
  })

  describe('refresh', () => {
    it('loads the page again when main reports a change, the window regains focus or Refresh is pressed', async () => {
      showChanges(changesData([]))
      let changed = (): void => {}
      vi.mocked(git().onChanged).mockImplementation((cb) => {
        changed = cb
        return () => {}
      })
      await renderSettled(<GitView workspaceId="w1" paneId="p1" />)
      expect(screen.getByText('No changes')).toBeInTheDocument()

      showChanges()
      await act(async () => changed())
      expect(fileRow('notes.txt')).not.toBeNull()
      expect(git().changes).toHaveBeenCalledTimes(2)

      await act(async () => {
        window.dispatchEvent(new Event('focus'))
      })
      expect(git().changes).toHaveBeenCalledTimes(3)

      await click(screen.getByRole('button', { name: 'Refresh' }))
      expect(git().changes).toHaveBeenCalledTimes(4)
    })

    it('stops listening once the view is gone', async () => {
      showChanges()
      const off = vi.fn()
      vi.mocked(git().onChanged).mockReturnValue(off)
      const view = await renderSettled(<GitView workspaceId="w1" paneId="p1" />)

      view.unmount()
      window.dispatchEvent(new Event('focus'))

      expect(off).toHaveBeenCalledTimes(1)
      expect(git().changes).toHaveBeenCalledTimes(1)
    })

    it('asks main to keep this workspace fresh', async () => {
      showChanges()
      await renderSettled(<GitView workspaceId="w1" paneId="p1" />)

      await waitFor(() => expect(git().watch).toHaveBeenCalledWith(['w1']))
    })
  })

  describe('tabs', () => {
    it('switches between changes and graph and offers no blame tab without a file', async () => {
      showChanges()
      showGraph()
      await renderSettled(<GitView workspaceId="w1" paneId="p1" />)
      expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Changes', 'Graph'])

      await click(screen.getByRole('tab', { name: 'Graph' }))

      await waitFor(() => expect(graphRow(HEAD)).not.toBeNull())
      expect(root().dataset.page).toBe('graph')
      expect(git().graph).toHaveBeenCalledWith('w1', 300)
    })

    it('follows the page a command asks for', async () => {
      showChanges()
      showGraph()
      await renderSettled(<GitView workspaceId="w1" paneId="p1" />)

      await openGraph()
      await waitFor(() => expect(graphRow(HEAD)).not.toBeNull())
      await act(async () => useGitViewStore.getState().navigate('p1', 'changes'))

      await waitFor(() => expect(fileRow('notes.txt')).not.toBeNull())
      expect(root().dataset.page).toBe('changes')
    })
  })

  describe('graph', () => {
    it('draws the uncommitted row above the commits with their refs', async () => {
      showGraph()
      await renderSettled(<GitView workspaceId="w1" paneId="p1" />)
      await openGraph()
      await waitFor(() => expect(graphRow(HEAD)).not.toBeNull())

      const rows = [...root().querySelectorAll('.graph-row')].map((r) => r.getAttribute('data-sha'))
      expect(rows).toEqual(['worktree', HEAD, SECOND, FIRST])
      const worktree = graphRow('worktree')
      expect(worktree).toHaveClass('worktree')
      expect(worktree).toHaveTextContent('Uncommitted changes')
      expect(worktree).toHaveTextContent('1 conflict')
      expect(worktree).toHaveTextContent('1 staged')
      expect(worktree).toHaveTextContent('1 unstaged')
      expect(worktree.querySelectorAll('.node.pending')).toHaveLength(1)
      expect(root().querySelectorAll('.edge.pending').length).toBeGreaterThan(0)
      const refs = [...graphRow(HEAD).querySelectorAll('.ref')].map((r) => r.textContent)
      expect(refs).toEqual(['main', 'v1.0'])
      expect(graphRow(HEAD).querySelector('.node.ring')).not.toBeNull()
      expect(graphRow(SECOND)).toHaveTextContent('add feature')
      expect(graphRow(SECOND)).toHaveTextContent('bbbbbbb')
    })

    it('leaves the uncommitted row out of a clean repository', async () => {
      showGraph(graphData({ ...changesData([]) }))
      await renderSettled(<GitView workspaceId="w1" paneId="p1" />)
      await openGraph()
      await waitFor(() => expect(graphRow(HEAD)).not.toBeNull())

      expect(graphRow('worktree')).toBeNull()
    })

    it('says a repository without commits has none', async () => {
      showGraph(graphData({ ...changesData([]), commits: [] }))
      await renderSettled(<GitView workspaceId="w1" paneId="p1" />)
      await openGraph()

      await waitFor(() => expect(screen.getByText('No commits yet')).toBeInTheDocument())
    })

    it('loads the files of the selected commit and opens the clicked one', async () => {
      showGraph()
      vi.mocked(git().commitFiles).mockResolvedValue({ ok: true, data: COMMIT_FILES })
      await renderSettled(<GitView workspaceId="w1" paneId="p1" />)
      await openGraph()
      await waitFor(() => expect(graphRow(SECOND)).not.toBeNull())

      await click(graphRow(SECOND))

      expect(graphRow(SECOND)).toHaveAttribute('aria-selected', 'true')
      const detail = root().querySelector('.detail') as HTMLElement
      expect(detail).toHaveAttribute('data-sha', SECOND)
      expect(detail).toHaveTextContent('Loading…')
      await waitFor(() => expect(fileRow('feature.txt')).not.toBeNull())
      expect(git().commitFiles).toHaveBeenCalledWith('w1', SECOND)
      expect(detail).toHaveTextContent('bbbbbbbbbb')

      await click(fileRow('feature.txt'))
      expect(git().openCommitFile).toHaveBeenCalledWith('w1', SECOND, 'feature.txt')

      await click(screen.getByRole('button', { name: 'Parents: ccccccc' }))
      expect(graphRow(FIRST)).toHaveAttribute('aria-selected', 'true')

      await click(screen.getByRole('button', { name: 'Close details' }))
      expect(root().querySelector('.detail')).toBeNull()
    })

    it('shows the change sections for the uncommitted row', async () => {
      showGraph()
      await renderSettled(<GitView workspaceId="w1" paneId="p1" />)
      await openGraph()
      await waitFor(() => expect(graphRow('worktree')).not.toBeNull())

      await click(graphRow('worktree'))

      const detail = root().querySelector('.detail') as HTMLElement
      expect(within(detail).getByRole('region', { name: 'Staged' })).toBeInTheDocument()
      await click(within(detail).getByRole('button', { name: 'Stage: notes.txt' }))
      expect(git().stage).toHaveBeenCalledWith('w1', { paths: ['/repo/notes.txt'], all: false })
      expect(git().commitFiles).not.toHaveBeenCalled()
    })

    it('moves the selection with the keyboard and clears it with Escape', async () => {
      showGraph()
      await renderSettled(<GitView workspaceId="w1" paneId="p1" />)
      await openGraph()
      await waitFor(() => expect(graphRow(HEAD)).not.toBeNull())
      const list = screen.getByRole('listbox', { name: 'Commit graph' })
      const selected = (): string | null =>
        root().querySelector('.graph-row[aria-selected="true"]')?.getAttribute('data-sha') ?? null

      fireEvent.keyDown(list, { key: 'ArrowDown' })
      expect(selected()).toBe('worktree')
      fireEvent.keyDown(list, { key: 'ArrowDown' })
      expect(selected()).toBe(HEAD)
      expect(list.getAttribute('aria-activedescendant')).toBe(graphRow(HEAD).id)
      fireEvent.keyDown(list, { key: 'End' })
      expect(selected()).toBe(FIRST)
      fireEvent.keyDown(list, { key: 'ArrowDown' })
      expect(selected()).toBe(FIRST)
      fireEvent.keyDown(list, { key: 'Home' })
      expect(selected()).toBe('worktree')
      fireEvent.keyDown(list, { key: 'Escape' })
      expect(selected()).toBeNull()
      expect(root().querySelector('.detail')).toBeNull()
    })

    it('keeps the selection and the list element across a refresh', async () => {
      showGraph()
      let changed = (): void => {}
      vi.mocked(git().onChanged).mockImplementation((cb) => {
        changed = cb
        return () => {}
      })
      await renderSettled(<GitView workspaceId="w1" paneId="p1" />)
      await openGraph()
      await waitFor(() => expect(graphRow(FIRST)).not.toBeNull())
      const list = screen.getByRole('listbox', { name: 'Commit graph' })
      list.focus()
      await click(graphRow(FIRST))

      showGraph(graphData())
      await act(async () => changed())

      expect(screen.getByRole('listbox', { name: 'Commit graph' })).toBe(list)
      expect(document.activeElement).toBe(list)
      expect(graphRow(FIRST)).toHaveAttribute('aria-selected', 'true')
    })

    it('paints a window of rows of a long history and asks for the next page near the end', async () => {
      const many = Array.from({ length: 300 }, (_, i) =>
        commitOf(String(i).padStart(40, '0'), `commit ${i}`, [String(i + 1).padStart(40, '0')]),
      )
      showGraph(graphData({ ...changesData([]), commits: many, more: true }))
      await renderSettled(<GitView workspaceId="w1" paneId="p1" />)
      await openGraph()
      await waitFor(() => expect(root().querySelector('.graph-row')).not.toBeNull())

      expect(root().querySelectorAll('.graph-row').length).toBeLessThan(60)
      expect(git().graph).toHaveBeenCalledTimes(1)
      const list = screen.getByRole('listbox', { name: 'Commit graph' })
      expect((list.firstElementChild as HTMLElement).style.height).toBe('7200px')

      list.scrollTop = 290 * 24
      await act(async () => {
        fireEvent.scroll(list)
      })

      expect(git().graph).toHaveBeenLastCalledWith('w1', 600)
      expect(git().graph).toHaveBeenCalledTimes(2)
      expect(root().querySelector('.graph-row[data-sha$="299"]')).not.toBeNull()
      expect(root().querySelector('.graph-row[data-sha$="000"]')).toBeNull()
    })

    it('changes the scope in main and in the settings', async () => {
      showGraph()
      vi.mocked(git().setScope).mockResolvedValue({ ok: true, data: { scope: { kind: 'all' } } })
      await renderSettled(<GitView workspaceId="w1" paneId="p1" />)
      await openGraph()
      await waitFor(() => expect(graphRow(HEAD)).not.toBeNull())
      const trigger = root().querySelector('.scope-trigger') as HTMLElement
      expect(trigger).toHaveTextContent('Current branch')

      await click(trigger)
      showGraph(graphData({ scope: { kind: 'all' } }))
      await click(document.querySelector('[data-scope="all"]') as HTMLElement)

      expect(git().setScope).toHaveBeenCalledWith('w1', { kind: 'all' })
      expect(useSettingsStore.getState().git.graphScope).toBe('all')
      await waitFor(() => expect(trigger).toHaveTextContent('All branches'))
    })

    it('chooses branches without touching the setting and keeps the last one chosen', async () => {
      const chosen = (refs: string[]): GitGraphData =>
        graphData({ scope: { kind: 'chosen', refs } })
      showGraph()
      vi.mocked(git().setScope).mockResolvedValue({ ok: true, data: { scope: { kind: 'all' } } })
      await renderSettled(<GitView workspaceId="w1" paneId="p1" />)
      await openGraph()
      await waitFor(() => expect(graphRow(HEAD)).not.toBeNull())
      const trigger = root().querySelector('.scope-trigger') as HTMLElement
      const branchBox = (ref: string): HTMLElement =>
        document.querySelector(`[data-branch="${ref}"]`) as HTMLElement

      await click(trigger)
      showGraph(chosen(['refs/heads/main']))
      await click(document.querySelector('[data-scope="chosen"]') as HTMLElement)

      expect(git().setScope).toHaveBeenLastCalledWith('w1', {
        kind: 'chosen',
        refs: ['refs/heads/main'],
      })
      expect(useSettingsStore.getState().git.graphScope).toBe('current')
      await waitFor(() => expect(branchBox('refs/heads/main')).not.toBeNull())
      expect(trigger).toHaveTextContent('main')
      expect(branchBox('refs/heads/main')).toHaveAttribute('aria-checked', 'true')
      expect(branchBox('refs/heads/main')).toHaveAttribute('aria-disabled', 'true')
      expect(screen.getByRole('group', { name: 'Remote' })).toHaveTextContent('origin/main')

      fireEvent.change(screen.getByRole('searchbox', { name: 'Filter branches' }), {
        target: { value: 'sid' },
      })
      expect(branchBox('refs/heads/main')).toBeNull()
      expect(screen.queryByRole('group', { name: 'Remote' })).toBeNull()

      showGraph(chosen(['refs/heads/main', 'refs/heads/side']))
      await click(branchBox('refs/heads/side'))
      expect(git().setScope).toHaveBeenLastCalledWith('w1', {
        kind: 'chosen',
        refs: ['refs/heads/main', 'refs/heads/side'],
      })
      await waitFor(() => expect(trigger).toHaveTextContent('2 branches'))

      fireEvent.change(screen.getByRole('searchbox', { name: 'Filter branches' }), {
        target: { value: 'zzz' },
      })
      expect(screen.getByText('No branches match')).toBeInTheDocument()
    })
  })

  describe('blame', () => {
    it('shows who last changed each line of the file a command names', async () => {
      showChanges()
      vi.mocked(git().blame).mockResolvedValue({ ok: true, data: BLAME })
      await renderSettled(<GitView workspaceId="w1" paneId="p1" />)

      await act(async () => useGitViewStore.getState().navigate('p1', 'blame', '/repo/src/a.ts'))

      await waitFor(() => expect(root().querySelector('table.blame')).not.toBeNull())
      expect(git().blame).toHaveBeenCalledWith('w1', '/repo/src/a.ts')
      expect(root().dataset.page).toBe('blame')
      expect(screen.getByRole('tab', { name: 'Blame' })).toHaveAttribute('aria-selected', 'true')
      const rows = [...root().querySelectorAll('table.blame tr')]
      expect(rows).toHaveLength(3)
      const who = rows.map((r) => r.querySelector('.blame-who') as HTMLElement)
      expect(who[0].textContent).toMatch(/^bbbbbbb Ada · /)
      expect(who[0].title).toContain('add feature')
      expect(who[1]).toBeEmptyDOMElement()
      expect(who[2]).toHaveTextContent('Not committed yet')
      expect(rows[0]).toHaveClass('blame-first')
      expect(rows[1]).not.toHaveClass('blame-first')
      expect(rows[2].querySelector('.blame-text')).toHaveTextContent('three')
      expect(rows[2].querySelector('.blame-no')).toHaveTextContent('3')
    })

    it('asks for a file when the blame page is opened without one', async () => {
      showChanges()
      await renderSettled(<GitView workspaceId="w1" paneId="p1" />)

      await act(async () => useGitViewStore.getState().navigate('p1', 'blame'))

      expect(screen.getByText('Open a file and run Git: Blame File')).toBeInTheDocument()
      expect(git().blame).not.toHaveBeenCalled()
    })
  })

  describe('split sizes', () => {
    it('resizes the details with the keyboard and remembers the size', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      showGraph()
      await renderSettled(<GitView workspaceId="w1" paneId="p1" />)
      await act(async () => useGitViewStore.getState().navigate('p1', 'graph'))
      await act(async () => {})
      await click(graphRow('worktree'))
      const handle = screen.getByRole('separator', { name: 'Resize details' })
      expect(handle).toHaveAttribute('aria-orientation', 'horizontal')
      const split = root().querySelector('[data-split="graph-details"]') as HTMLElement
      vi.spyOn(split, 'clientHeight', 'get').mockReturnValue(400)
      const first = split.querySelector('.ostia-split-first') as HTMLElement
      vi.spyOn(first, 'getBoundingClientRect').mockReturnValue({ height: 200 } as DOMRect)

      fireEvent.keyDown(handle, { key: 'ArrowUp' })

      act(() => {
        vi.advanceTimersByTime(PANEL_SIZES_WRITE_DELAY_MS)
      })
      const saved = JSON.parse(window.localStorage.getItem(PANEL_SIZES_KEY) ?? '{}')
      expect(saved['git:graph-details']).toBeCloseTo(0.46)
    })

    it('drags the details taller without selecting text and keeps the size when the graph opens again', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const basis = vi.spyOn(Object.getPrototypeOf(document.body.style), 'flexBasis', 'set')
      showGraph()
      const view = await renderSettled(<GitView workspaceId="w1" paneId="p1" />)
      await act(async () => useGitViewStore.getState().navigate('p1', 'graph'))
      await act(async () => {})
      await click(graphRow('worktree'))
      const split = root().querySelector('[data-split="graph-details"]') as HTMLElement
      vi.spyOn(split, 'clientHeight', 'get').mockReturnValue(400)
      const first = split.querySelector('.ostia-split-first') as HTMLElement
      vi.spyOn(first, 'getBoundingClientRect').mockReturnValue({ height: 200 } as DOMRect)
      const handle = screen.getByRole('separator', { name: 'Resize details' })
      Object.assign(handle, { setPointerCapture: () => {}, hasPointerCapture: () => true })
      const pointer = (type: string, clientY: number): boolean => {
        const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientY, button: 0 })
        Object.defineProperty(event, 'pointerId', { value: 1 })
        return fireEvent(handle, event)
      }

      expect(pointer('pointerdown', 300)).toBe(false)
      expect(document.documentElement).toHaveClass('ostia-split-dragging')
      act(() => {
        pointer('pointermove', 260)
        pointer('pointermove', 200)
      })
      fireEvent(handle, new Event('lostpointercapture'))

      expect(document.documentElement).not.toHaveClass('ostia-split-dragging')
      expect(basis).toHaveBeenLastCalledWith(expect.stringContaining(' 25%,'))
      act(() => {
        vi.advanceTimersByTime(PANEL_SIZES_WRITE_DELAY_MS)
      })
      const saved = JSON.parse(window.localStorage.getItem(PANEL_SIZES_KEY) ?? '{}')
      expect(saved['git:graph-details']).toBe(0.25)

      view.unmount()
      await renderSettled(<GitView workspaceId="w1" paneId="p1" />)
      await act(async () => {})
      basis.mockClear()
      await click(graphRow('worktree'))
      expect(basis).toHaveBeenLastCalledWith(expect.stringContaining(' 25%,'))
      basis.mockRestore()
    })

    it('keeps a handle between the commit box and the changed files', async () => {
      showChanges()
      await renderSettled(<GitView workspaceId="w1" paneId="p1" />)

      expect(
        root().querySelectorAll('[data-split="changes-commit"] [role="separator"]'),
      ).toHaveLength(1)
    })
  })
})
