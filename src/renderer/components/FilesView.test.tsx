import '@testing-library/jest-dom/vitest'
import type { ExtensionInfo } from '@shared/extensions'
import type { LoadedIconTheme } from '@shared/iconTheme'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createPane } from '../layout/tree'
import { useExtensionsStore } from '../stores/extensionsStore'
import { useIconThemeStore } from '../stores/iconThemeStore'
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

const ICON_THEME: LoadedIconTheme = {
  id: 'fixture-icons',
  label: 'Fixture Icons',
  icons: { ts: 'data:ts', file: 'data:file' },
  base: {
    file: 'file',
    fileExtensions: { ts: 'ts' },
    fileNames: {},
    folderNames: {},
    folderNamesExpanded: {},
    languageIds: {},
  },
}

function iconThemeExtension(): ExtensionInfo {
  return {
    id: 'fixture-icons',
    name: 'Fixture Icons',
    version: '1.0.0',
    description: '',
    builtin: false,
    enabled: true,
    status: 'idle',
    requested: [],
    granted: [],
    unapproved: [],
    commands: [],
    panel: null,
    paneChips: [],
    workspaceChips: [],
    settings: [],
    settingValues: {},
    assist: [],
    secrets: [],
    secretsSet: [],
    category: 'other',
    languages: [],
    languageServers: [],
    iconThemes: [{ id: 'fixture-icons', label: 'Fixture Icons' }],
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
  let extensionsInit: ReturnType<typeof useExtensionsStore.getState>
  let iconThemeInit: ReturnType<typeof useIconThemeStore.getState>

  beforeAll(() => {
    extensionsInit = useExtensionsStore.getState()
    iconThemeInit = useIconThemeStore.getState()
    workspacesInit = useWorkspacesStore.getState()
    layoutInit = useLayoutStore.getState()
    settingsInit = useSettingsStore.getState()
  })

  afterEach(() => {
    cleanup()
    useWorkspacesStore.setState(workspacesInit, true)
    useLayoutStore.setState(layoutInit, true)
    useSettingsStore.setState(settingsInit, true)
    useExtensionsStore.setState(extensionsInit, true)
    useIconThemeStore.setState(iconThemeInit, true)
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

  it('hides entries matching files.exclude, including the default **/.git', async () => {
    seedWorkspace(CWD)
    listReturns([
      { name: '.git', dir: true },
      { name: '.env', dir: false },
      { name: 'visible.ts', dir: false },
    ])

    render(<FilesView />)

    expect(await screen.findByRole('button', { name: 'visible.ts' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '.env' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '.git' })).not.toBeInTheDocument()

    act(() => {
      useSettingsStore.getState().setFiles({ exclude: ['**/.*'] })
    })

    expect(screen.queryByRole('button', { name: '.env' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'visible.ts' })).toBeInTheDocument()
  })

  it('shows excluded entries dimmed while the eye toggle is on', async () => {
    seedWorkspace(CWD)
    listReturns([
      { name: '.git', dir: true },
      { name: 'a.ts', dir: false },
    ])
    const user = userEvent.setup()

    render(<FilesView />)
    await screen.findByRole('button', { name: 'a.ts' })
    const eye = screen.getByRole('button', { name: 'Show hidden files' })
    expect(eye).toHaveAttribute('aria-pressed', 'false')

    await user.click(eye)

    expect(useSettingsStore.getState().files.showExcluded).toBe(true)
    expect(eye).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '.git' })).toHaveClass('excluded')
    expect(screen.getByRole('button', { name: 'a.ts' })).not.toHaveClass('excluded')
  })

  it('hides a row from its context menu and shows it again', async () => {
    seedWorkspace(CWD)
    listReturns([
      { name: 'secret.txt', dir: false },
      { name: 'a.ts', dir: false },
    ])
    const user = userEvent.setup()

    render(<FilesView />)
    fireEvent.contextMenu(await screen.findByRole('button', { name: 'secret.txt' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Hide in tree' }))

    expect(useSettingsStore.getState().files.exclude).toContain(`${CWD}/secret.txt`)
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'secret.txt' })).not.toBeInTheDocument(),
    )

    act(() => {
      useSettingsStore.getState().setFiles({ showExcluded: true })
    })
    fireEvent.contextMenu(screen.getByRole('button', { name: 'secret.txt' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Show in tree' }))

    expect(useSettingsStore.getState().files.exclude).not.toContain(`${CWD}/secret.txt`)
  })

  it('compacts a single-folder chain into one row when it is expanded', async () => {
    seedWorkspace(CWD)
    vi.mocked(window.pine.fs.list).mockImplementation(async (p) => {
      if (p === CWD) return [{ name: 'src', dir: true }]
      if (p === `${CWD}/src`) return [{ name: 'main', dir: true }]
      if (p === `${CWD}/src/main`) return [{ name: 'java', dir: true }]
      if (p === `${CWD}/src/main/java`) return [{ name: 'App.java', dir: false }]
      return []
    })
    const user = userEvent.setup()

    render(<FilesView />)
    await user.click(await screen.findByRole('button', { name: 'src' }))

    expect(await screen.findByRole('button', { name: 'src/main/java' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'App.java' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'main' })).not.toBeInTheDocument()
  })

  it('expands folder by folder when compact folders is off', async () => {
    seedWorkspace(CWD)
    useSettingsStore.getState().setFiles({ compactFolders: false })
    vi.mocked(window.pine.fs.list).mockImplementation(async (p) => {
      if (p === CWD) return [{ name: 'src', dir: true }]
      if (p === `${CWD}/src`) return [{ name: 'main', dir: true }]
      return []
    })
    const user = userEvent.setup()

    render(<FilesView />)
    await user.click(await screen.findByRole('button', { name: 'src' }))

    expect(await screen.findByRole('button', { name: 'main' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'src' })).toBeInTheDocument()
  })

  it('nests related files under their parent, expanded from its twisty or ArrowRight', async () => {
    seedWorkspace(CWD)
    listReturns([
      { name: 'package.json', dir: false },
      { name: 'pnpm-lock.yaml', dir: false },
      { name: 'index.ts', dir: false },
      { name: 'index.test.ts', dir: false },
    ])
    const openFile = vi.spyOn(useLayoutStore.getState(), 'openFile').mockImplementation(() => {})
    const user = userEvent.setup()

    render(<FilesView />)
    const parent = await screen.findByRole('button', { name: 'package.json' })
    expect(parent).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: 'pnpm-lock.yaml' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'index.test.ts' })).not.toBeInTheDocument()

    await user.click(parent.querySelector('.file-twisty') as Element)

    expect(parent).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: 'pnpm-lock.yaml' })).toBeInTheDocument()
    expect(openFile).not.toHaveBeenCalled()

    await user.click(parent)
    expect(openFile).toHaveBeenCalledWith('s1', `${CWD}/package.json`)
    expect(parent).toHaveAttribute('aria-expanded', 'true')

    const ts = screen.getByRole('button', { name: 'index.ts' })
    ts.focus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('button', { name: 'index.test.ts' })).toBeInTheDocument()
    await user.keyboard('{ArrowLeft}')
    expect(screen.queryByRole('button', { name: 'index.test.ts' })).not.toBeInTheDocument()

    act(() => {
      useSettingsStore.getState().setFiles({
        nesting: { ...useSettingsStore.getState().files.nesting, enabled: false },
      })
    })
    expect(screen.getByRole('button', { name: 'index.test.ts' })).toBeInTheDocument()
  })

  it('sorts folders first by default and mixed or by type from the settings', async () => {
    seedWorkspace(CWD)
    listReturns([
      { name: 'b.md', dir: false },
      { name: 'a.ts', dir: false },
      { name: 'c', dir: true },
    ])
    const rowNames = () =>
      Array.from(document.querySelectorAll('.file-row')).map((r) => r.textContent)

    render(<FilesView />)
    await screen.findByRole('button', { name: 'a.ts' })
    expect(rowNames()).toEqual(['c', 'a.ts', 'b.md'])

    act(() => useSettingsStore.getState().setFiles({ sortOrder: 'mixed' }))
    expect(rowNames()).toEqual(['a.ts', 'b.md', 'c'])

    act(() => useSettingsStore.getState().setFiles({ sortOrder: 'foldersFirst', sortBy: 'type' }))
    expect(rowNames()).toEqual(['c', 'b.md', 'a.ts'])
  })

  it('draws icons from the chosen icon theme and falls back when it is unavailable', async () => {
    seedWorkspace(CWD)
    listReturns([
      { name: 'main.ts', dir: false },
      { name: 'notes.txt', dir: false },
    ])
    useExtensionsStore.setState({ list: [iconThemeExtension()] })
    vi.mocked(window.pine.iconThemes.load).mockResolvedValue(ICON_THEME)
    useSettingsStore.getState().setFiles({ iconTheme: 'fixture-icons' })

    render(<FilesView />)
    const row = await screen.findByRole('button', { name: 'main.ts' })
    await waitFor(() =>
      expect(row.querySelector('img.file-icon-theme')).toHaveAttribute('src', 'data:ts'),
    )
    expect(window.pine.iconThemes.load).toHaveBeenCalledWith('fixture-icons')
    expect(screen.getByRole('button', { name: 'notes.txt' }).querySelector('img')).toHaveAttribute(
      'src',
      'data:file',
    )

    act(() => {
      useSettingsStore.getState().setFiles({ iconTheme: 'pine' })
    })
    expect(row.querySelector('img')).toBeNull()
    expect(row.querySelector('svg.file-icon')).not.toBeNull()
  })

  it('shows the empty-folder state when the directory has no entries', async () => {
    seedWorkspace(CWD)
    listReturns([])

    render(<FilesView />)

    expect(await screen.findByText('No folder open')).toBeInTheDocument()
    expect(document.querySelector('.file-row')).toBeNull()
    expect(screen.getByRole('button', { name: 'Close Files' })).toBeInTheDocument()
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
