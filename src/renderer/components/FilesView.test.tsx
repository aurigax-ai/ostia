import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createPane } from '../layout/tree'
import { useLayoutStore } from '../stores/layoutStore'
import { useSettingsStore } from '../stores/settingsStore'
import { type Workspace, useWorkspacesStore } from '../stores/workspacesStore'
import { FilesView } from './FilesView'

const CWD = '/home/me/project'

function seedWorkspace(anchor = CWD, paneCwd?: string): void {
  const workspace: Workspace = {
    id: 's1',
    name: 'project',
    kind: 'terminal',
    workDir: anchor,
    state: 'idle',
  }
  useWorkspacesStore.setState({ workspaces: [workspace], activeWorkspaceId: 's1' })
  useLayoutStore.getState().ensure('s1')
  if (paneCwd !== undefined) {
    const paneId = useLayoutStore.getState().byWorkspace.s1.activePaneId
    useLayoutStore.getState().setCwd('s1', paneId, paneCwd)
  }
}

function focusedPaneId(): string {
  return useLayoutStore.getState().byWorkspace.s1.activePaneId
}

function listReturns(entries: { name: string; dir: boolean }[]): void {
  vi.mocked(window.pine.fs.list).mockResolvedValue(entries)
}

describe('FilesView', () => {
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
  let layoutInit: ReturnType<typeof useLayoutStore.getState>
  let settingsInit: ReturnType<typeof useSettingsStore.getState>

  beforeAll(() => {
    workspacesInit = useWorkspacesStore.getState()
    layoutInit = useLayoutStore.getState()
    settingsInit = useSettingsStore.getState()
  })

  afterEach(() => {
    cleanup()
    useWorkspacesStore.setState(workspacesInit, true)
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

    expect(await screen.findByRole('button', { name: 'src' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'index.ts' })).toBeInTheDocument()
  })

  it('requests the listing for the focused pane cwd, not the workspace anchor', async () => {
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
    expect(screen.queryByRole('button', { name: 'here.ts' })).not.toBeInTheDocument()
  })

  it('falls back to the workspace workDir anchor when the focused pane has no cwd', async () => {
    useWorkspacesStore.setState({
      workspaces: [
        { id: 's1', name: 'anchor', kind: 'terminal', workDir: '/anchor/dir', state: 'idle' },
      ],
      activeWorkspaceId: 's1',
    })
    const pane = createPane('terminal')
    useLayoutStore.setState({
      byWorkspace: { s1: { root: pane, activePaneId: pane.id, zoomedPaneId: null } },
    })
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

    await user.click(dirRow)
    expect(await screen.findByRole('button', { name: 'app.ts' })).toBeInTheDocument()

    await user.click(dirRow)
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
    expect(screen.getByRole('button', { name: 'visible.ts' })).toBeInTheDocument()
  })

  it('shows the empty-folder state when the directory has no entries', async () => {
    seedWorkspace(CWD)
    listReturns([])

    render(<FilesView />)

    expect(await screen.findByText('No folder open')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('renders the cwd breadcrumb and exposes entries as named buttons (a11y)', async () => {
    seedWorkspace(CWD)
    listReturns([{ name: 'src', dir: true }])

    render(<FilesView />)

    const current = screen.getByText('project')
    await userEvent.setup().hover(current)
    expect(await screen.findByText(CWD, {}, { timeout: 3000 })).toBeInTheDocument()

    const row = await screen.findByRole('button', { name: 'src' })
    expect(row.tagName).toBe('BUTTON')
  })
})
