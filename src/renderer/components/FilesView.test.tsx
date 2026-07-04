import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createPane } from '../layout/tree'
import { useLayoutStore } from '../stores/layoutStore'
import { type Session, useSessionsStore } from '../stores/sessionsStore'
import { useSettingsStore } from '../stores/settingsStore'
import { FilesView } from './FilesView'

/**
 * FilesView is the sidebar file explorer. It derives the cwd from the FOCUSED pane
 * (layoutStore) falling back to the session workDir anchor (sessionsStore), lazily lists
 * each directory over the `window.pine.fs.list` bridge, hides dotfiles per
 * settingsStore.behavior.showHiddenFiles, and — on a row click — either expands a
 * directory in place or opens a file via `useLayoutStore.getState().openFile`.
 *
 * These tests assert the REAL wiring end to end: the bridge is called for the right path,
 * the returned entries render as accessible buttons, and clicks reach the store actions.
 *
 * Mocking: only `window.pine.fs.list` (already a vi.fn from test/setup.ts's per-test
 * `window.pine` fake). No module mocks are needed — FilesView pulls in no Monaco/xterm/
 * allotment; useDict/fileIcon/lucide all render under jsdom untouched.
 */

const CWD = '/home/me/project'

/** Seed an active session + a focused pane whose cwd is `paneCwd` (defaults to the anchor). */
function seedWorkspace(anchor = CWD, paneCwd?: string): void {
  const session: Session = {
    id: 's1',
    name: 'project',
    kind: 'terminal',
    workDir: anchor,
    state: 'idle',
  }
  useSessionsStore.setState({ sessions: [session], activeSessionId: 's1' })
  // ensure() reads the session workDir into the new pane's cwd.
  useLayoutStore.getState().ensure('s1')
  if (paneCwd !== undefined) {
    const paneId = useLayoutStore.getState().bySession.s1.activePaneId
    useLayoutStore.getState().setCwd('s1', paneId, paneCwd)
  }
}

/** The id of the (single) focused pane in the seeded session. */
function focusedPaneId(): string {
  return useLayoutStore.getState().bySession.s1.activePaneId
}

/** Point the fs.list bridge at a fixed listing for the focused cwd. */
function listReturns(entries: { name: string; dir: boolean }[]): void {
  vi.mocked(window.pine.fs.list).mockResolvedValue(entries)
}

describe('FilesView', () => {
  let sessionsInit: ReturnType<typeof useSessionsStore.getState>
  let layoutInit: ReturnType<typeof useLayoutStore.getState>
  let settingsInit: ReturnType<typeof useSettingsStore.getState>

  beforeAll(() => {
    // Snapshot pristine store state (data + stable action fns) before any test mutates it.
    sessionsInit = useSessionsStore.getState()
    layoutInit = useLayoutStore.getState()
    settingsInit = useSettingsStore.getState()
  })

  afterEach(() => {
    // Unmount BEFORE touching the stores: a still-mounted tree would re-render on reset
    // and fire a stray fs.list against the about-to-be-restored bridge mock.
    cleanup()
    // Replace (not merge) so seeded panes/sessions/settings never bleed between tests.
    useSessionsStore.setState(sessionsInit, true)
    useLayoutStore.setState(layoutInit, true)
    useSettingsStore.setState(settingsInit, true)
    vi.restoreAllMocks()
  })

  it('renders the directory + file entries returned by fs.list', async () => {
    seedWorkspace()
    listReturns([
      { name: 'src', dir: true },
      { name: 'index.ts', dir: false },
    ])

    render(<FilesView />)

    // Both a directory and a file entry render (they arrive after the fs.list promise).
    expect(await screen.findByRole('button', { name: 'src' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'index.ts' })).toBeInTheDocument()
  })

  it('requests the listing for the focused pane cwd, not the session anchor', async () => {
    // Anchor differs from the pane cwd — the explorer must follow the pane.
    seedWorkspace('/home/me/project', '/var/log')
    listReturns([{ name: 'syslog', dir: false }])

    render(<FilesView />)
    await screen.findByRole('button', { name: 'syslog' })

    expect(window.pine.fs.list).toHaveBeenCalledWith('/var/log')
    expect(window.pine.fs.list).not.toHaveBeenCalledWith('/home/me/project')
  })

  it('re-lists when the focused pane cwd changes (follows the terminal)', async () => {
    seedWorkspace(CWD)
    vi.mocked(window.pine.fs.list).mockImplementation(async (p) =>
      p === CWD ? [{ name: 'here.ts', dir: false }] : [{ name: 'elsewhere.ts', dir: false }],
    )

    render(<FilesView />)
    await screen.findByRole('button', { name: 'here.ts' })

    act(() => {
      useLayoutStore.getState().setCwd('s1', focusedPaneId(), '/elsewhere')
    })

    expect(await screen.findByRole('button', { name: 'elsewhere.ts' })).toBeInTheDocument()
    expect(window.pine.fs.list).toHaveBeenCalledWith('/elsewhere')
    // The tree is keyed by cwd, so the stale listing is dropped (not merged).
    expect(screen.queryByRole('button', { name: 'here.ts' })).not.toBeInTheDocument()
  })

  it('falls back to the session workDir anchor when the focused pane has no cwd', async () => {
    // A pane with cwd === undefined exercises useFocusedCwd's `findPane(...).cwd ?? anchor`.
    useSessionsStore.setState({
      sessions: [
        { id: 's1', name: 'anchor', kind: 'terminal', workDir: '/anchor/dir', state: 'idle' },
      ],
      activeSessionId: 's1',
    })
    const pane = createPane('terminal') // createPane with no cwd arg → cwd is undefined
    useLayoutStore.setState({ bySession: { s1: { root: pane, activePaneId: pane.id } } })
    listReturns([{ name: 'anchored.ts', dir: false }])

    render(<FilesView />)
    await screen.findByRole('button', { name: 'anchored.ts' })

    expect(window.pine.fs.list).toHaveBeenCalledWith('/anchor/dir')
  })

  it('opens a file via layoutStore.openFile with its full path when a file row is clicked', async () => {
    seedWorkspace(CWD)
    listReturns([{ name: 'index.ts', dir: false }])
    const openFile = vi.spyOn(useLayoutStore.getState(), 'openFile').mockImplementation(() => {})

    render(<FilesView />)
    const fileRow = await screen.findByRole('button', { name: 'index.ts' })
    await userEvent.setup().click(fileRow)

    expect(openFile).toHaveBeenCalledWith('s1', '/home/me/project/index.ts')
  })

  it('joins the child path without doubling the slash when the cwd ends in /', async () => {
    seedWorkspace('/tmp/')
    listReturns([{ name: 'a.ts', dir: false }])
    const openFile = vi.spyOn(useLayoutStore.getState(), 'openFile').mockImplementation(() => {})

    render(<FilesView />)
    await userEvent.setup().click(await screen.findByRole('button', { name: 'a.ts' }))

    expect(openFile).toHaveBeenCalledWith('s1', '/tmp/a.ts')
  })

  it('expands a directory in place and lists its children when a folder row is clicked', async () => {
    seedWorkspace(CWD)
    vi.mocked(window.pine.fs.list).mockImplementation(async (p) => {
      if (p === CWD) return [{ name: 'src', dir: true }]
      if (p === `${CWD}/src`) return [{ name: 'app.ts', dir: false }]
      return []
    })

    render(<FilesView />)
    const dirRow = await screen.findByRole('button', { name: 'src' })
    // Child is not listed until the directory is expanded.
    expect(screen.queryByRole('button', { name: 'app.ts' })).not.toBeInTheDocument()

    await userEvent.setup().click(dirRow)

    expect(await screen.findByRole('button', { name: 'app.ts' })).toBeInTheDocument()
    expect(window.pine.fs.list).toHaveBeenCalledWith('/home/me/project/src')
  })

  it('collapses an expanded directory when its row is clicked a second time', async () => {
    seedWorkspace(CWD)
    vi.mocked(window.pine.fs.list).mockImplementation(async (p) => {
      if (p === CWD) return [{ name: 'src', dir: true }]
      if (p === `${CWD}/src`) return [{ name: 'app.ts', dir: false }]
      return []
    })
    const user = userEvent.setup()

    render(<FilesView />)
    const dirRow = await screen.findByRole('button', { name: 'src' })

    await user.click(dirRow) // expand
    expect(await screen.findByRole('button', { name: 'app.ts' })).toBeInTheDocument()

    await user.click(dirRow) // collapse
    expect(screen.queryByRole('button', { name: 'app.ts' })).not.toBeInTheDocument()
  })

  it('hides dotfiles when settings.showHiddenFiles is false', async () => {
    seedWorkspace(CWD)
    useSettingsStore.setState((s) => ({ behavior: { ...s.behavior, showHiddenFiles: false } }))
    listReturns([
      { name: '.env', dir: false },
      { name: 'visible.ts', dir: false },
    ])

    render(<FilesView />)

    expect(await screen.findByRole('button', { name: 'visible.ts' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '.env' })).not.toBeInTheDocument()
  })

  it('live-toggles dotfile visibility when showHiddenFiles changes (subscribes to settings)', async () => {
    // Start with dotfiles shown, then flip the setting AFTER render — proves Dir subscribes
    // live to the store rather than reading it once. (Guards against a false-green where the
    // filter is only correct because the setting was fixed before the first render.)
    seedWorkspace(CWD)
    useSettingsStore.setState((s) => ({ behavior: { ...s.behavior, showHiddenFiles: true } }))
    listReturns([
      { name: '.env', dir: false },
      { name: 'visible.ts', dir: false },
    ])

    render(<FilesView />)
    expect(await screen.findByRole('button', { name: '.env' })).toBeInTheDocument()

    act(() => {
      useSettingsStore.setState((s) => ({ behavior: { ...s.behavior, showHiddenFiles: false } }))
    })

    expect(screen.queryByRole('button', { name: '.env' })).not.toBeInTheDocument()
    // The non-hidden entry stays put (no re-list, just a re-filter).
    expect(screen.getByRole('button', { name: 'visible.ts' })).toBeInTheDocument()
  })

  it('shows the empty-folder state when the directory has no entries', async () => {
    seedWorkspace(CWD)
    listReturns([])

    render(<FilesView />)

    // i18n string from the English catalog (rail.noFolder).
    expect(await screen.findByText('No folder open')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('renders the cwd breadcrumb and exposes entries as named buttons (a11y)', async () => {
    seedWorkspace(CWD)
    listReturns([{ name: 'src', dir: true }])

    render(<FilesView />)

    // Breadcrumb: the container is titled with the full cwd, last segment is shown.
    expect(screen.getByTitle(CWD)).toBeInTheDocument()
    expect(screen.getByText('project')).toBeInTheDocument()

    // Entries are real <button>s named by their filename — reachable by role, not test-id.
    const row = await screen.findByRole('button', { name: 'src' })
    expect(row.tagName).toBe('BUTTON')
  })
})
