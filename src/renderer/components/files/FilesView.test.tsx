import '@testing-library/jest-dom/vitest'
import { createPane } from '@/layout/tree'
import { loadHomeDir } from '@/lib/files/homeDir'
import { registerTerminal } from '@/lib/terminal/terminalHandles'
import { startAgentGroupsSync, useAgentGroupsStore } from '@/stores/agents/agentGroupsStore'
import { useSandboxStore } from '@/stores/app/sandboxStore'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useExtensionsStore } from '@/stores/extensions/extensionsStore'
import { useIconThemeStore } from '@/stores/extensions/iconThemeStore'
import { useRemoteFoldersStore } from '@/stores/files/remoteFoldersStore'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { type Workspace, useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import type { ExtensionInfo } from '@shared/extensions'
import type { LoadedIconTheme } from '@shared/iconTheme'
import type { AgentGroupPlacement } from '@shared/permissions/reach'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Terminal } from '@xterm/xterm'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
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
    settingsPage: null,
    category: 'other',
    languages: [],
    languageServers: [],
    agentSkills: [],
    agentHooks: [],
    iconThemes: [{ id: 'fixture-icons', label: 'Fixture Icons' }],
    keymaps: [],
  }
}

function focusedPaneId(): string {
  return useLayoutStore.getState().byWorkspace.s1.activePaneId
}

function listReturns(entries: { name: string; dir: boolean }[]): void {
  vi.mocked(window.ostia.fs.list).mockResolvedValue(entries)
}

describe('FilesView', () => {
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
  let layoutInit: ReturnType<typeof useLayoutStore.getState>
  let settingsInit: ReturnType<typeof useSettingsStore.getState>
  let extensionsInit: ReturnType<typeof useExtensionsStore.getState>
  let iconThemeInit: ReturnType<typeof useIconThemeStore.getState>
  let blocksInit: ReturnType<typeof useBlocksStore.getState>
  let sandboxInit: ReturnType<typeof useSandboxStore.getState>
  let agentGroupsInit: ReturnType<typeof useAgentGroupsStore.getState>

  beforeAll(() => {
    extensionsInit = useExtensionsStore.getState()
    iconThemeInit = useIconThemeStore.getState()
    workspacesInit = useWorkspacesStore.getState()
    layoutInit = useLayoutStore.getState()
    settingsInit = useSettingsStore.getState()
    blocksInit = useBlocksStore.getState()
    sandboxInit = useSandboxStore.getState()
    agentGroupsInit = useAgentGroupsStore.getState()
  })

  afterEach(() => {
    cleanup()
    useWorkspacesStore.setState(workspacesInit, true)
    useLayoutStore.setState(layoutInit, true)
    useSettingsStore.setState(settingsInit, true)
    useExtensionsStore.setState(extensionsInit, true)
    useIconThemeStore.setState(iconThemeInit, true)
    useBlocksStore.setState(blocksInit, true)
    useSandboxStore.setState(sandboxInit, true)
    useAgentGroupsStore.setState(agentGroupsInit, true)
    useRemoteFoldersStore.setState({ folders: [], pending: null })
    vi.restoreAllMocks()
  })

  describe('remote folders', () => {
    const FOLDER = {
      id: 'abcdef012345',
      workspaceId: 's1',
      extId: 'shelf',
      extName: 'Shelf',
      host: 'dev@db',
      root: '/srv/app',
    }
    const ROOT = 'remote://abcdef012345/srv/app'

    function remoteLists(listing: Record<string, { name: string; dir: boolean }[]>): void {
      vi.mocked(window.ostia.remoteFiles.list).mockImplementation(async (path) =>
        listing[path]
          ? { ok: true, entries: listing[path], truncated: false }
          : { ok: false, error: 'unavailable' },
      )
    }

    it('SSH-C65 shows a remote folder as its own section with a Remote badge, the host and the path', async () => {
      seedWorkspace()
      listReturns([{ name: 'local.ts', dir: false }])
      remoteLists({ [ROOT]: [{ name: 'app.conf', dir: false }] })
      useRemoteFoldersStore.setState({ folders: [FOLDER] })

      render(<FilesView />)

      const section = await screen.findByTestId('remote-folder')
      expect(section).toHaveTextContent('Remote')
      expect(section).toHaveTextContent('dev@db')
      expect(section).toHaveTextContent('/srv/app')
      expect(await screen.findByRole('button', { name: 'app.conf' })).toBeInTheDocument()
      expect(screen.getByText('This computer')).toBeInTheDocument()
      expect(await screen.findByRole('button', { name: 'local.ts' })).toBeInTheDocument()
      expect(window.ostia.remoteFiles.list).toHaveBeenCalledWith(ROOT)
      expect(window.ostia.fs.list).not.toHaveBeenCalledWith(ROOT)
    })

    it('shows no remote section for a folder of another workspace', async () => {
      seedWorkspace()
      listReturns([{ name: 'local.ts', dir: false }])
      useRemoteFoldersStore.setState({ folders: [{ ...FOLDER, workspaceId: 'other' }] })

      render(<FilesView />)

      await screen.findByRole('button', { name: 'local.ts' })
      expect(screen.queryByTestId('remote-folder')).not.toBeInTheDocument()
      expect(window.ostia.remoteFiles.list).not.toHaveBeenCalled()
    })

    it('opens a remote file in the editor by its remote path and lists a remote folder when expanded', async () => {
      seedWorkspace()
      listReturns([])
      remoteLists({
        [ROOT]: [
          { name: 'conf', dir: true },
          { name: 'app.conf', dir: false },
        ],
        [`${ROOT}/conf`]: [{ name: 'db.yaml', dir: false }],
      })
      useRemoteFoldersStore.setState({ folders: [FOLDER] })
      const user = userEvent.setup()

      render(<FilesView />)

      await user.click(await screen.findByRole('button', { name: 'conf' }))
      await user.click(await screen.findByRole('button', { name: 'db.yaml' }))
      const layout = useLayoutStore.getState().byWorkspace.s1
      const editor = layout.root.type === 'pane' ? layout.root : null
      expect(JSON.stringify(layout.root)).toContain(`${ROOT}/conf/db.yaml`)
      expect(editor?.cwd ?? CWD).toBe(CWD)
      expect(window.ostia.fs.list).not.toHaveBeenCalledWith(expect.stringContaining('remote://'))
    })

    it('says why a remote folder could not be listed', async () => {
      seedWorkspace()
      listReturns([])
      remoteLists({})
      useRemoteFoldersStore.setState({ folders: [FOLDER] })

      render(<FilesView />)

      expect(await screen.findByRole('alert')).toHaveTextContent('The host is not reachable')
    })

    it('closes a remote folder and reloads it from its head buttons', async () => {
      seedWorkspace()
      listReturns([])
      remoteLists({ [ROOT]: [{ name: 'app.conf', dir: false }] })
      useRemoteFoldersStore.setState({ folders: [FOLDER] })
      const user = userEvent.setup()

      render(<FilesView />)
      await screen.findByRole('button', { name: 'app.conf' })

      await user.click(screen.getByRole('button', { name: 'Reload' }))
      await waitFor(() => expect(window.ostia.remoteFiles.list).toHaveBeenCalledTimes(2))
      await user.click(screen.getByRole('button', { name: 'Close remote folder' }))
      expect(window.ostia.remoteFiles.close).toHaveBeenCalledWith('abcdef012345')
    })
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

    expect(window.ostia.fs.list).toHaveBeenCalledWith('/var/log')
    expect(window.ostia.fs.list).not.toHaveBeenCalledWith('/home/me/project')
  })

  it('re-lists when the focused pane cwd changes (follows the terminal)', async () => {
    seedWorkspace(CWD)
    vi.mocked(window.ostia.fs.list).mockImplementation(async (p) =>
      p === CWD ? [{ name: 'here.ts', dir: false }] : [{ name: 'elsewhere.ts', dir: false }],
    )

    render(<FilesView />)
    await screen.findByRole('button', { name: 'here.ts' })

    act(() => {
      useLayoutStore.getState().setCwd('s1', focusedPaneId(), '/elsewhere')
    })

    expect(await screen.findByRole('button', { name: 'elsewhere.ts' })).toBeInTheDocument()
    expect(window.ostia.fs.list).toHaveBeenCalledWith('/elsewhere')
    expect(screen.queryByRole('button', { name: 'here.ts' })).not.toBeInTheDocument()
  })

  it('the Files panel follows the active workspace', async () => {
    seedWorkspace(CWD, '/tmp')
    listReturns([])

    render(<FilesView />)
    await act(async () => {})
    expect(screen.getByText('tmp')).toHaveClass('current')

    act(() => {
      useWorkspacesStore.getState().addWorkspace()
    })
    await act(async () => {})
    expect(screen.getByText('~')).toHaveClass('current')
    expect(screen.queryByText('tmp')).not.toBeInTheDocument()

    act(() => {
      useWorkspacesStore.getState().setActive('s1')
    })
    await act(async () => {})
    expect(screen.getByText('tmp')).toHaveClass('current')
    expect(window.ostia.fs.list).toHaveBeenLastCalledWith('/tmp')
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

    expect(window.ostia.fs.list).toHaveBeenCalledWith('/anchor/dir')
  })

  it('keeps the tree at the workspace folder when a file in a subfolder is the focused pane', async () => {
    seedWorkspace(CWD)
    vi.mocked(window.ostia.fs.list).mockImplementation(async (p) =>
      p === CWD ? [{ name: 'notes', dir: true }] : [{ name: 'deep.json', dir: false }],
    )

    act(() => {
      useLayoutStore.getState().openFile('s1', `${CWD}/notes/deep.json`)
    })
    render(<FilesView />)

    expect(await screen.findByRole('button', { name: 'notes' })).toBeInTheDocument()
    expect(window.ostia.fs.list).toHaveBeenCalledWith(CWD)
    expect(screen.getByText('project')).toHaveClass('current')
  })

  it('opens the folders down to the focused file and marks its row current', async () => {
    seedWorkspace(CWD)
    vi.mocked(window.ostia.fs.list).mockImplementation(async (p) =>
      p === CWD
        ? [
            { name: 'notes', dir: true },
            { name: 'other', dir: true },
          ]
        : [{ name: 'deep.json', dir: false }],
    )

    act(() => {
      useLayoutStore.getState().openFile('s1', `${CWD}/notes/deep.json`)
    })
    render(<FilesView />)

    const row = await screen.findByRole('button', { name: 'deep.json' })
    expect(row).toHaveAttribute('aria-current', 'true')
    expect(screen.getByRole('button', { name: 'notes' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: 'other' })).toHaveAttribute('aria-expanded', 'false')
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
    vi.mocked(window.ostia.fs.list).mockImplementation(async (p) => {
      if (p === CWD) return [{ name: 'src', dir: true }]
      if (p === `${CWD}/src`) return [{ name: 'app.ts', dir: false }]
      return []
    })

    render(<FilesView />)
    const dirRow = await screen.findByRole('button', { name: 'src' })
    expect(screen.queryByRole('button', { name: 'app.ts' })).not.toBeInTheDocument()

    await userEvent.setup().click(dirRow)

    expect(await screen.findByRole('button', { name: 'app.ts' })).toBeInTheDocument()
    expect(window.ostia.fs.list).toHaveBeenCalledWith('/home/me/project/src')
  })

  it('collapses an expanded directory when its row is clicked a second time', async () => {
    seedWorkspace(CWD)
    vi.mocked(window.ostia.fs.list).mockImplementation(async (p) => {
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

  it('a file path goes to an agent in another workspace of the sidebar group once the human grouped them', async () => {
    useWorkspacesStore.setState({
      workspaces: [
        { id: 's1', name: 'project', kind: 'terminal', workDir: CWD, state: 'idle' },
        { id: 's2', name: 'agents', kind: 'terminal', workDir: CWD, state: 'idle' },
      ],
      activeWorkspaceId: 's1',
    })
    useLayoutStore.getState().ensure('s1')
    useLayoutStore.getState().ensure('s2')
    const agentPane = useLayoutStore.getState().byWorkspace.s2.activePaneId
    useBlocksStore.setState({
      running: { [agentPane]: 'b-agent' },
      agentBlocks: { [agentPane]: { blockId: 'b-agent', agent: 'claude' } },
    })
    const term = { paste: vi.fn(), focus: vi.fn() }
    const unregister = registerTerminal(agentPane, term as unknown as Terminal)
    vi.mocked(window.ostia.sandbox.get).mockResolvedValue({ enabled: false } as never)
    const stopSync = startAgentGroupsSync()
    const publish = vi.mocked(window.ostia.approvals.onAgentGroupsChanged).mock.calls[0][0] as (
      placements: AgentGroupPlacement[],
    ) => void
    listReturns([{ name: 'notes.md', dir: false }])
    const user = userEvent.setup()

    render(<FilesView />)
    const openSendPath = async (): Promise<void> => {
      fireEvent.contextMenu(await screen.findByRole('button', { name: 'notes.md' }))
      const trigger = await screen.findByRole('menuitem', { name: 'Send path to agent' })
      act(() => trigger.focus())
      await user.keyboard('{ArrowRight}')
    }
    await waitFor(() => expect(useAgentGroupsStore.getState().placements).toEqual([]))

    await openSendPath()
    expect(
      await screen.findByRole('menuitem', { name: 'No agent is running in this workspace.' }),
    ).toBeVisible()
    await user.keyboard('{Escape}{Escape}')

    let home = ''
    act(() => {
      home = useWorkspacesStore.getState().createGroup('s2') ?? ''
      useWorkspacesStore.getState().moveToGroup('s1', home)
      publish([{ workspaceId: 's1', groupId: home }])
    })

    await openSendPath()
    expect(
      await screen.findByRole('menuitem', { name: 'No agent is running in this workspace.' }),
    ).toBeVisible()
    await user.keyboard('{Escape}{Escape}')

    act(() => {
      const own = useWorkspacesStore.getState().createGroup('s1') ?? ''
      useWorkspacesStore.getState().moveToGroup('s2', own)
    })
    expect(useWorkspacesStore.getState().groups).toHaveLength(1)

    await openSendPath()
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'Claude Code · Terminal (agents)' }),
    )

    await waitFor(() => expect(term.paste).toHaveBeenCalledWith(`@${CWD}/notes.md `))
    stopSync()
    unregister()
  })

  it('compacts a single-folder chain into one row when it is expanded', async () => {
    seedWorkspace(CWD)
    vi.mocked(window.ostia.fs.list).mockImplementation(async (p) => {
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
    vi.mocked(window.ostia.fs.list).mockImplementation(async (p) => {
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
    vi.mocked(window.ostia.iconThemes.load).mockResolvedValue(ICON_THEME)
    useSettingsStore.getState().setFiles({ iconTheme: 'fixture-icons' })

    render(<FilesView />)
    const row = await screen.findByRole('button', { name: 'main.ts' })
    await waitFor(() =>
      expect(row.querySelector('img.file-icon-theme')).toHaveAttribute('src', 'data:ts'),
    )
    expect(window.ostia.iconThemes.load).toHaveBeenCalledWith('fixture-icons')
    expect(screen.getByRole('button', { name: 'notes.txt' }).querySelector('img')).toHaveAttribute(
      'src',
      'data:file',
    )

    act(() => {
      useSettingsStore.getState().setFiles({ iconTheme: 'ostia' })
    })
    expect(row.querySelector('img')).toBeNull()
    expect(row.querySelector('svg.file-icon')).not.toBeNull()
  })

  it('a VS Code icon theme from an extension, compact folders, nesting and hiding in the Files tree', async () => {
    seedWorkspace(CWD)
    vi.mocked(window.ostia.fs.list).mockImplementation(async (p) => {
      if (p === CWD) {
        return [
          { name: 'src', dir: true },
          { name: 'package.json', dir: false },
          { name: 'pnpm-lock.yaml', dir: false },
          { name: 'index.ts', dir: false },
          { name: 'index.test.ts', dir: false },
          { name: 'secret.txt', dir: false },
        ]
      }
      if (p === `${CWD}/src`) return [{ name: 'main', dir: true }]
      if (p === `${CWD}/src/main`) return [{ name: 'java', dir: true }]
      if (p === `${CWD}/src/main/java`) return [{ name: 'App.java', dir: false }]
      return []
    })
    const theme: LoadedIconTheme = {
      id: 'fixture-icons',
      label: 'Fixture Icons',
      icons: {
        _file: 'data:image/svg+xml;base64,file',
        _folder: 'data:image/svg+xml;base64,folder',
        _folder_open: 'data:image/svg+xml;base64,folder-open',
        _typescript: 'data:image/svg+xml;base64,typescript',
        _typescript_test: 'data:image/svg+xml;base64,typescript-test',
        _npm: 'data:image/png;base64,npm',
        _folder_src: 'data:image/svg+xml;base64,folder-src',
        _folder_src_open: 'data:image/svg+xml;base64,folder-src-open',
      },
      base: {
        file: '_file',
        folder: '_folder',
        folderExpanded: '_folder_open',
        fileExtensions: { ts: '_typescript', 'test.ts': '_typescript_test' },
        fileNames: { 'package.json': '_npm' },
        folderNames: { src: '_folder_src' },
        folderNamesExpanded: { src: '_folder_src_open' },
        languageIds: {},
      },
    }
    useExtensionsStore.setState({ list: [iconThemeExtension()] })
    vi.mocked(window.ostia.iconThemes.load).mockResolvedValue(theme)
    const user = userEvent.setup()
    const row = (name: string) => screen.getByRole('button', { name })
    const icon = (name: string) => row(name).querySelector('img.file-icon-theme')

    render(<FilesView />)
    expect(await screen.findByRole('button', { name: 'package.json' })).toBeInTheDocument()
    expect(row('package.json').querySelector('img')).toBeNull()

    act(() => {
      useSettingsStore.getState().setFiles({ iconTheme: 'fixture-icons' })
    })
    await waitFor(() =>
      expect(icon('package.json')).toHaveAttribute(
        'src',
        expect.stringMatching(/^data:image\/png;base64,/),
      ),
    )
    expect(icon('index.ts')).toHaveAttribute(
      'src',
      expect.stringMatching(/^data:image\/svg\+xml;base64,/),
    )
    const srcFolderIcon = icon('src')?.getAttribute('src')

    expect(screen.queryByRole('button', { name: 'pnpm-lock.yaml' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'index.test.ts' })).not.toBeInTheDocument()
    await user.click(row('index.ts').querySelector('.file-twisty') as Element)
    expect(row('index.test.ts')).toBeInTheDocument()
    expect(icon('index.test.ts')?.getAttribute('src')).not.toBe(
      icon('index.ts')?.getAttribute('src'),
    )

    await user.click(row('src'))
    expect(
      await screen.findByRole('button', { name: 'src/main/java' }, { timeout: 3000 }),
    ).toBeInTheDocument()
    expect(row('App.java')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'main' })).not.toBeInTheDocument()
    expect(icon('src/main/java')?.getAttribute('src')).not.toBe(srcFolderIcon)

    fireEvent.contextMenu(row('secret.txt'))
    await user.click(await screen.findByRole('menuitem', { name: 'Hide in tree' }))
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'secret.txt' })).not.toBeInTheDocument(),
    )
    await user.click(screen.getByRole('button', { name: 'Show hidden files' }))
    expect(row('secret.txt')).toHaveClass('excluded')
  })

  it('shows the empty-folder state when the directory has no entries', async () => {
    seedWorkspace(CWD)
    listReturns([])

    render(<FilesView />)

    expect(await screen.findByText('No folder open')).toBeInTheDocument()
    expect(document.querySelector('.file-row')).toBeNull()
    expect(screen.getByRole('button', { name: 'Close Files' })).toBeInTheDocument()
  })

  describe('breadcrumb', () => {
    const LONG = '/home/me/Personal/terminal/.sdd/verify'
    const CHAR_WIDTH = 10

    function lineWidth(width: number): void {
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
        this: HTMLElement,
      ) {
        return this.classList.contains('files-crumb-line') ? width : 0
      })
      vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (
        this: HTMLElement,
      ) {
        return (this.textContent ?? '').length * CHAR_WIDTH
      })
    }

    const crumbText = (): string[] =>
      Array.from(document.querySelectorAll('.files-crumb-line .crumb')).map(
        (el) => el.textContent ?? '',
      )

    it('shows home as ~ and full names when the path fits', async () => {
      lineWidth(1000)
      seedWorkspace(LONG)
      listReturns([])
      await loadHomeDir()

      render(<FilesView />)
      await act(async () => {})

      expect(crumbText()).toEqual(['~', 'Personal', 'terminal', '.sdd', 'verify'])
    })

    it('shortens, then folds, only as far as the width needs', async () => {
      await loadHomeDir()
      seedWorkspace(LONG)
      listReturns([])

      lineWidth(150)
      const { unmount } = render(<FilesView />)
      await act(async () => {})
      expect(crumbText()).toEqual(['~', 'P', 't', '.s', 'verify'])
      unmount()

      lineWidth(90)
      render(<FilesView />)
      await act(async () => {})
      expect(crumbText()).toEqual(['…', '.s', 'verify'])
    })

    it('never shortens with the full style', async () => {
      await loadHomeDir()
      lineWidth(50)
      seedWorkspace(LONG)
      listReturns([])
      useSettingsStore.getState().setFiles({ breadcrumb: 'full' })

      render(<FilesView />)
      await act(async () => {})

      expect(crumbText()).toEqual(['~', 'Personal', 'terminal', '.sdd', 'verify'])
    })

    it('always shortens with the short style, even when the path fits', async () => {
      await loadHomeDir()
      lineWidth(1000)
      seedWorkspace(LONG)
      listReturns([])
      useSettingsStore.getState().setFiles({ breadcrumb: 'short' })

      render(<FilesView />)
      await act(async () => {})

      expect(crumbText()).toEqual(['~', 'P', 't', '.s', 'verify'])
    })
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
