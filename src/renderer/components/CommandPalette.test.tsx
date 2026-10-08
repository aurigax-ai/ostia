import '@testing-library/jest-dom/vitest'
import { zhHant } from '@shared/dict'
import type { SearchOutcome } from '@shared/search'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerBuiltinCommands } from '../commands/builtins'
import { commands } from '../commands/registry'
import { languagesFrom } from '../lib/languagePacks'
import { useEditorRevealStore } from '../stores/editorRevealStore'
import { useLayoutStore } from '../stores/layoutStore'
import { usePluginsStore } from '../stores/pluginsStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { useWindowsStore } from '../stores/windowsStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { CommandPalette } from './CommandPalette'

const searchWorkspaceSymbols = vi.hoisted(() => vi.fn())
vi.mock('../lsp/client', () => ({ searchWorkspaceSymbols }))

describe('CommandPalette', () => {
  let uiInit: ReturnType<typeof useUIStore.getState>

  beforeAll(() => {
    if (!commands.has('palette.toggle')) registerBuiltinCommands()
    uiInit = useUIStore.getState()
  })

  afterEach(() => {
    cleanup()
    useUIStore.setState(uiInit, true)
    useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null })
    useLayoutStore.setState({ byWorkspace: {} })
    vi.restoreAllMocks()
  })

  it('does not mount the palette dialog while paletteOpen is false', () => {
    render(<CommandPalette />)

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByRole('option')).toBeNull()
  })

  it('lists the visible built-in commands (hidden ones excluded) when open', async () => {
    useUIStore.setState({ paletteOpen: true })
    render(<CommandPalette />)

    expect(await screen.findByRole('combobox')).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Split Pane Right/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Toggle Sidebar/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Open Settings/ })).toBeInTheDocument()
    expect(screen.queryByText('pane.split')).toBeNull()
  })

  it('filters the list to matching commands as the user types', async () => {
    useUIStore.setState({ paletteOpen: true })
    render(<CommandPalette />)
    const input = await screen.findByRole('combobox')

    await userEvent.type(input, 'Open')

    expect(await screen.findByRole('option', { name: /Open Settings/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /Toggle Sidebar/ })).toBeNull()
    expect(screen.queryByRole('option', { name: /Split Pane Right/ })).toBeNull()
  })

  it('ranks the command whose words start with what was typed first, across groups', async () => {
    commands.register({
      id: 'ssh.connect',
      title: 'SSH: Connect to Host…',
      category: 'SSH',
      run: vi.fn(),
    })
    try {
      useUIStore.setState({ paletteOpen: true })
      render(<CommandPalette />)
      await userEvent.type(await screen.findByRole('combobox'), 'ssh connect')
      await waitFor(() =>
        expect(screen.getAllByRole('option')[0]).toHaveAccessibleName(/SSH: Connect to Host/),
      )
    } finally {
      act(() => commands.unregister('ssh.connect'))
    }
  })

  it('runs the selected command via commands.exec and closes the palette', async () => {
    useUIStore.setState({ paletteOpen: true })
    const exec = vi.spyOn(commands, 'exec').mockResolvedValue({ ok: true, result: undefined })
    render(<CommandPalette />)

    await userEvent.click(await screen.findByRole('option', { name: /Open Settings/ }))

    expect(exec).toHaveBeenCalledWith('app.openSettings', undefined)
    expect(window.ostia.telemetry.count).toHaveBeenCalledWith(
      'features',
      'command',
      'app.openSettings',
    )
    expect(useUIStore.getState().paletteOpen).toBe(false)
  })

  it('exposes an accessible combobox input and named option rows (a11y)', async () => {
    useUIStore.setState({ paletteOpen: true })
    render(<CommandPalette />)

    const input = await screen.findByRole('combobox')
    expect(input.tagName).toBe('INPUT')
    expect(input).toHaveAttribute('placeholder', 'Search commands, workspaces, tabs… (? for help)')
    expect(screen.getByRole('option', { name: /Open Settings/ })).toBeInTheDocument()
  })

  describe('row layout', () => {
    const initialPlugins = usePluginsStore.getState()
    const initialSettings = useSettingsStore.getState()
    const initialWindows = useWindowsStore.getState()

    afterEach(() => {
      cleanup()
      useWindowsStore.setState(initialWindows, true)
      usePluginsStore.setState(initialPlugins, true)
      useSettingsStore.setState(initialSettings, true)
    })

    const cells = (option: HTMLElement): HTMLElement[] => {
      const row = option.querySelector('[data-slot="palette-row"]') as HTMLElement
      return [...row.children] as HTMLElement[]
    }

    const seedPlaces = () => {
      useWorkspacesStore.setState({
        workspaces: [
          {
            id: 'w1',
            name: 'api',
            customName: 'payments',
            kind: 'terminal',
            workDir: '/src/api',
            state: 'idle',
          },
        ],
        activeWorkspaceId: 'w1',
      })
      useLayoutStore.setState({
        byWorkspace: {
          w1: {
            root: { type: 'pane', id: 'pane-7', title: 'Fix refunds', kind: 'terminal' },
            activePaneId: 'pane-7',
            zoomedPaneId: null,
          },
        },
      })
    }

    const SLOTS = ['palette-name', 'palette-keys', 'palette-meta']

    const expectColumns = (option: HTMLElement) => {
      const row = cells(option)
      expect(row.map((cell) => cell.dataset.slot)).toEqual(SLOTS)
      const grid = option.querySelector('[data-slot="palette-row"]') as HTMLElement
      expect(grid).toHaveClass('grid')
      expect(grid.className).toContain('var(--palette-name-w')
      expect(grid.className).toContain('var(--palette-keys-w')
      expect(row[2]).toHaveClass('justify-self-end', 'truncate', 'min-w-0')
      return row
    }

    it('lays a command out as title, keycap, then id on the right', async () => {
      useUIStore.setState({ paletteOpen: true })
      render(<CommandPalette />)

      const [title, keys, id] = expectColumns(
        await screen.findByRole('option', { name: /Open Settings/ }),
      )

      expect(title).toHaveTextContent('Open Settings')
      expect(keys.querySelector('kbd')).not.toBeNull()
      expect(id).toHaveTextContent('app.openSettings')
      expect(id).not.toContainElement(keys)
    })

    it('keeps the keycap column in place for a command without a keybinding', async () => {
      useUIStore.setState({ paletteOpen: true })
      render(<CommandPalette />)
      const options = await screen.findAllByRole('option')

      const unbound = options.find((o) => !o.querySelector('kbd'))
      expect(unbound).toBeDefined()
      const [, keys, id] = expectColumns(unbound as HTMLElement)

      expect(keys).toBeEmptyDOMElement()
      expect(id.textContent).not.toBe('')
    })

    it('lays a workspace out as name, empty keycap column, then path', async () => {
      seedPlaces()
      useUIStore.setState({ paletteOpen: true, paletteSeed: '@' })
      render(<CommandPalette />)

      const [title, keys, path] = expectColumns(
        await screen.findByRole('option', { name: /payments/ }),
      )

      expect(title).toHaveTextContent('payments')
      expect(keys).toBeEmptyDOMElement()
      expect(path).toHaveTextContent('/src/api')
    })

    it('lays a tab out as title, empty keycap column, then its workspace', async () => {
      seedPlaces()
      useUIStore.setState({ paletteOpen: true, paletteSeed: '#' })
      render(<CommandPalette />)

      const [title, keys, where] = expectColumns(
        await screen.findByRole('option', { name: /Fix refunds/ }),
      )

      expect(title).toHaveTextContent('Fix refunds')
      expect(keys).toBeEmptyDOMElement()
      expect(where).toHaveTextContent('payments')
    })

    it('lays a file out as name, empty keycap column, then folder', async () => {
      seedPlaces()
      vi.mocked(window.ostia.search.run).mockResolvedValue({
        ok: true,
        results: {
          root: '/src/api',
          names: [{ path: 'src/lib/greet.ts', dir: false, positions: [0] }],
          files: [],
          pdfs: [],
          matches: 0,
          truncated: false,
        },
      })
      useUIStore.setState({ paletteOpen: true, paletteSeed: '/gre' })
      render(<CommandPalette />)

      const [title, keys, dir] = expectColumns(await screen.findByRole('option', { name: /greet/ }))

      expect(title).toHaveTextContent('greet.ts')
      expect(keys).toBeEmptyDOMElement()
      expect(dir).toHaveTextContent('src/lib')
    })

    it('lays a workspace from another window out the same way', async () => {
      useWindowsStore.setState({
        windowId: 'win-a',
        list: [
          {
            windowId: 'win-b',
            detached: true,
            workspaces: [
              {
                id: 'w9',
                name: 'billing',
                workDir: '/src/billing',
                state: 'idle',
                unreadAt: 0,
                panes: [],
              },
            ],
          },
        ],
      })
      useUIStore.setState({ paletteOpen: true, paletteSeed: '@' })
      render(<CommandPalette />)

      const [title, keys, path] = expectColumns(
        await screen.findByRole('option', { name: /billing/ }),
      )

      expect(title).toHaveTextContent('billing')
      expect(keys).toBeEmptyDOMElement()
      expect(path).toHaveTextContent('/src/billing')
    })

    it('lays an argument choice out in the same columns', async () => {
      commands.register<{ argument?: string }, void>({
        id: 'test.layout-card',
        title: 'Test: Layout Card',
        argument: 'Card id',
        choices: async () => [{ value: 'shop-12', label: 'Fix checkout' }],
        run: vi.fn(),
      })
      useUIStore.setState({ paletteOpen: true })
      render(<CommandPalette />)
      await userEvent.type(await screen.findByRole('combobox'), 'Test: Layout Card{Enter}')

      const [title, keys] = expectColumns(
        await screen.findByRole('option', { name: /Fix checkout/ }),
      )

      expect(title).toHaveTextContent('Fix checkout')
      expect(keys).toBeEmptyDOMElement()
    })

    it('keeps the title whole and lets the secondary text give way first', async () => {
      useUIStore.setState({ paletteOpen: true })
      render(<CommandPalette />)

      const [title, , id] = cells(await screen.findByRole('option', { name: /Open Settings/ }))

      expect(title).toHaveClass('overflow-hidden', 'max-w-full')
      expect(id).toHaveClass('truncate', 'min-w-0', 'justify-self-end')
    })

    it('lays rows out the same way in Traditional Chinese', async () => {
      usePluginsStore.setState({
        languages: languagesFrom([
          { extId: 'langpack-zh-hant', id: 'zh-Hant', label: '繁體中文', catalog: zhHant },
        ]),
      })
      useSettingsStore.setState({ locale: 'zh-Hant' })
      useUIStore.setState({ paletteOpen: true })
      render(<CommandPalette />)

      const [title, , id] = expectColumns(
        await screen.findByRole('option', { name: /向右分割窗格/ }),
      )

      expect(title).toHaveTextContent('向右分割窗格')
      expect(id).toHaveAttribute('data-slot', 'palette-meta')
    })
  })

  describe('prefixes', () => {
    const seed = () => {
      useWorkspacesStore.setState({
        workspaces: [
          {
            id: 'w1',
            name: 'api',
            customName: 'payments',
            kind: 'terminal',
            workDir: '/src/api',
            state: 'idle',
          },
          { id: 'w2', name: 'web', kind: 'terminal', workDir: '/src/web', state: 'idle' },
        ],
        activeWorkspaceId: 'w2',
      })
      useLayoutStore.setState({
        byWorkspace: {
          w1: {
            root: { type: 'pane', id: 'pane-7', title: '✳ Fix refunds', kind: 'terminal' },
            activePaneId: 'pane-7',
            zoomedPaneId: null,
          },
        },
      })
      useUIStore.setState({ paletteOpen: true })
    }

    it('lists the prefixes when the user types ?', async () => {
      seed()
      render(<CommandPalette />)
      await userEvent.type(await screen.findByRole('combobox'), '?')

      expect(screen.getByRole('option', { name: /^>\s*Commands$/ })).toBeInTheDocument()
      expect(screen.getByRole('option', { name: /^@\s*Workspaces$/ })).toBeInTheDocument()
      expect(screen.getByRole('option', { name: /^#\s*Tabs$/ })).toBeInTheDocument()
      expect(screen.queryByRole('option', { name: /Open Settings/ })).toBeNull()
    })

    it('fills in the prefix picked from help', async () => {
      seed()
      render(<CommandPalette />)
      const input = await screen.findByRole('combobox')
      await userEvent.type(input, '?')
      await userEvent.click(screen.getByRole('option', { name: /^@\s*Workspaces$/ }))

      expect(input).toHaveValue('@')
      expect(screen.getByRole('option', { name: /payments/ })).toBeInTheDocument()
    })

    it('switches to a workspace found with @', async () => {
      seed()
      render(<CommandPalette />)
      await userEvent.type(await screen.findByRole('combobox'), '@pay')
      expect(screen.queryByRole('option', { name: /Open Settings/ })).toBeNull()

      await userEvent.click(screen.getByRole('option', { name: /payments/ }))

      expect(useWorkspacesStore.getState().activeWorkspaceId).toBe('w1')
      expect(useUIStore.getState().paletteOpen).toBe(false)
    })

    it('finds a tab in any workspace with #', async () => {
      seed()
      render(<CommandPalette />)
      await userEvent.type(await screen.findByRole('combobox'), '#refunds')
      expect(screen.getByRole('option', { name: /Fix refunds\s*payments/ })).toBeInTheDocument()
      expect(screen.queryByRole('option', { name: /^payments/ })).toBeNull()
    })

    it('shows only commands with >', async () => {
      seed()
      render(<CommandPalette />)
      await userEvent.type(await screen.findByRole('combobox'), '>')
      expect(screen.getByRole('option', { name: /Open Settings/ })).toBeInTheDocument()
      expect(screen.queryByRole('option', { name: /payments/ })).toBeNull()
    })
  })

  describe('commands that take an argument', () => {
    afterEach(() => act(() => commands.unregister('test.card')))

    const register = (run = vi.fn()) => {
      commands.register<{ argument?: string }, void>({
        id: 'test.card',
        title: 'Test: Open Card',
        argument: 'Card id',
        run,
      })
      return run
    }

    it('asks for the value, then runs the command with it and closes', async () => {
      const run = register()
      useUIStore.setState({ paletteOpen: true })
      render(<CommandPalette />)
      await userEvent.click(await screen.findByRole('option', { name: /Test: Open Card/ }))

      const input = screen.getByPlaceholderText('Card id')
      expect(input).toHaveAttribute('placeholder', 'Card id')
      expect(screen.getByText('Type a value, then press Enter')).toBeInTheDocument()
      expect(run).not.toHaveBeenCalled()
      expect(useUIStore.getState().paletteOpen).toBe(true)

      await userEvent.type(input, ' shop-12 ')
      expect(
        screen.getByText('Press Enter to run Test: Open Card with “shop-12”'),
      ).toBeInTheDocument()
      await userEvent.keyboard('{Enter}')
      expect(run).toHaveBeenCalledWith({ argument: 'shop-12' }, expect.anything())
      expect(useUIStore.getState().paletteOpen).toBe(false)
    })

    it('puts the keyboard in the value input so the human types without clicking it', async () => {
      const run = register()
      useUIStore.setState({ paletteOpen: true })
      render(<CommandPalette />)
      await userEvent.type(await screen.findByRole('combobox'), 'Test: Open Card{Enter}')

      const input = await screen.findByPlaceholderText('Card id')
      expect(input).toHaveFocus()
      await userEvent.keyboard('shop-12{Enter}')
      expect(run).toHaveBeenCalledWith({ argument: 'shop-12' }, expect.anything())
    })

    it('puts the keyboard in the filter input of a command that offers choices', async () => {
      commands.register<{ argument?: string }, void>({
        id: 'test.card',
        title: 'Test: Open Card',
        argument: 'Card id',
        choices: async () => [{ value: 'shop-12', label: 'Fix checkout' }],
        run: vi.fn(),
      })
      useUIStore.setState({ paletteOpen: true })
      render(<CommandPalette />)
      await userEvent.type(await screen.findByRole('combobox'), 'Test: Open Card{Enter}')

      expect(await screen.findByRole('option', { name: /Fix checkout/ })).toBeInTheDocument()
      expect(screen.getByPlaceholderText('Card id')).toHaveFocus()
    })

    it('reopens on the command list after the palette chord closed it mid-argument', async () => {
      const run = register()
      useUIStore.setState({ paletteOpen: true })
      render(<CommandPalette />)
      await userEvent.click(await screen.findByRole('option', { name: /Test: Open Card/ }))
      expect(screen.getByPlaceholderText('Card id')).toBeInTheDocument()

      act(() => useUIStore.getState().togglePalette())
      expect(useUIStore.getState().paletteOpen).toBe(false)
      act(() => useUIStore.getState().togglePalette())

      expect(await screen.findByRole('option', { name: /Test: Open Card/ })).toBeInTheDocument()
      expect(screen.queryByPlaceholderText('Card id')).toBeNull()
      expect(run).not.toHaveBeenCalled()
    })

    it('runs nothing while the value is blank', async () => {
      const run = register()
      useUIStore.setState({ paletteOpen: true })
      render(<CommandPalette />)
      await userEvent.click(await screen.findByRole('option', { name: /Test: Open Card/ }))
      await userEvent.type(screen.getByPlaceholderText('Card id'), '   {Enter}')
      expect(run).not.toHaveBeenCalled()
      expect(useUIStore.getState().paletteOpen).toBe(true)
    })
  })
  describe('languages', () => {
    const initialPlugins = usePluginsStore.getState()
    const initialSettings = useSettingsStore.getState()

    const loadChinese = (): void => {
      usePluginsStore.setState({
        languages: languagesFrom([
          { extId: 'langpack-zh-hant', id: 'zh-Hant', label: '繁體中文', catalog: zhHant },
        ]),
      })
    }

    afterEach(() => {
      cleanup()
      usePluginsStore.setState(initialPlugins, true)
      useSettingsStore.setState(initialSettings, true)
      commands.unregister('hello.open')
    })

    it('shows core commands in the human’s language and changes when they switch it', async () => {
      loadChinese()
      useUIStore.setState({ paletteOpen: true })
      render(<CommandPalette />)
      expect(await screen.findByRole('option', { name: /Split Pane Right/ })).toBeInTheDocument()

      act(() => useSettingsStore.setState({ locale: 'zh-Hant' }))

      expect(screen.getByRole('option', { name: /向右分割窗格/ })).toBeInTheDocument()
      expect(screen.queryByRole('option', { name: /Split Pane Right/ })).toBeNull()
      expect(screen.getByRole('group', { name: '窗格' })).toBeInTheDocument()

      act(() => useSettingsStore.setState({ locale: 'en' }))

      expect(screen.getByRole('option', { name: /Split Pane Right/ })).toBeInTheDocument()
    })

    it('finds a command by its translated title and by its English one', async () => {
      loadChinese()
      useSettingsStore.setState({ locale: 'zh-Hant' })
      useUIStore.setState({ paletteOpen: true })
      render(<CommandPalette />)
      const input = await screen.findByRole('combobox')

      await userEvent.type(input, 'Open Settings')
      expect(await screen.findByRole('option', { name: /開啟設定/ })).toBeInTheDocument()
      expect(screen.queryByRole('option', { name: /切換側邊欄/ })).toBeNull()

      await userEvent.clear(input)
      await userEvent.type(input, '開啟設定')
      expect(await screen.findByRole('option', { name: /開啟設定/ })).toBeInTheDocument()
      expect(screen.queryByRole('option', { name: /切換側邊欄/ })).toBeNull()
    })

    it('keeps the registry title English for agents while the palette shows Chinese', async () => {
      loadChinese()
      useSettingsStore.setState({ locale: 'zh-Hant' })
      useUIStore.setState({ paletteOpen: true })
      render(<CommandPalette />)
      expect(await screen.findByRole('option', { name: /開啟設定/ })).toBeInTheDocument()

      const described = commands.describe().find((c) => c.id === 'app.openSettings')
      expect(described).toMatchObject({ title: 'Open Settings', category: 'App' })
    })

    it('shows an extension command as main sent it, beside translated core commands', async () => {
      loadChinese()
      useSettingsStore.setState({ locale: 'zh-Hant' })
      commands.register({
        id: 'hello.open',
        title: '哈囉：開啟面板',
        category: '哈囉',
        run: () => {},
      })
      useUIStore.setState({ paletteOpen: true })
      render(<CommandPalette />)

      expect(await screen.findByRole('option', { name: /哈囉：開啟面板/ })).toBeInTheDocument()
      expect(screen.getByRole('group', { name: '哈囉' })).toBeInTheDocument()
      expect(screen.getByRole('option', { name: /開啟設定/ })).toBeInTheDocument()
    })
  })

  describe('symbols in the workspace', () => {
    const hit = {
      id: 'ext/fake\n/src/web/lib/greet.ts\n12\n17\ngreet\n12',
      name: 'greet',
      kind: 12,
      container: 'lib',
      path: '/src/web/lib/greet.ts',
      line: 12,
      column: 17,
      serverKey: 'ext/fake',
    }

    const seed = () => {
      useWorkspacesStore.setState({
        workspaces: [
          { id: 'w2', name: 'web', kind: 'terminal', workDir: '/src/web', state: 'idle' },
        ],
        activeWorkspaceId: 'w2',
      })
      useLayoutStore.setState({
        byWorkspace: {
          w2: {
            root: { type: 'pane', id: 'pane-3', title: 'a.ts', kind: 'editor' },
            activePaneId: 'pane-3',
            zoomedPaneId: null,
          },
        },
      })
    }

    afterEach(() => {
      cleanup()
      searchWorkspaceSymbols.mockReset()
      useEditorRevealStore.setState({ pending: {} })
    })

    it('opens on the symbol prefix from the command and asks the workspace’s servers as the human types', async () => {
      seed()
      searchWorkspaceSymbols.mockResolvedValue({ servers: 1, hits: [hit] })
      render(<CommandPalette />)
      act(() => {
        void commands.exec('view.goToWorkspaceSymbol')
      })
      const input = await screen.findByRole('combobox')
      expect(input).toHaveValue('%')
      await userEvent.type(input, 'gre')

      const option = await screen.findByRole('option', { name: /greet/ })
      expect(option).toHaveTextContent('lib/greet.ts:12')
      await waitFor(() =>
        expect(searchWorkspaceSymbols).toHaveBeenLastCalledWith(new Set(['pane-3']), 'gre'),
      )
      expect(screen.queryByRole('option', { name: /Open Settings/ })).toBeNull()
    })

    it('opens the file at the symbol and closes', async () => {
      seed()
      searchWorkspaceSymbols.mockResolvedValue({ servers: 1, hits: [hit] })
      const openFile = vi.spyOn(useLayoutStore.getState(), 'openFile').mockImplementation(() => {})
      useUIStore.setState({ paletteOpen: true, paletteSeed: '%' })
      render(<CommandPalette />)
      await userEvent.click(await screen.findByRole('option', { name: /greet/ }))

      expect(openFile).toHaveBeenCalledWith('w2', '/src/web/lib/greet.ts')
      expect(useEditorRevealStore.getState().pending['/src/web/lib/greet.ts']).toEqual({
        line: 12,
        column: 17,
      })
      expect(useUIStore.getState().paletteOpen).toBe(false)
    })

    it('says so when no language server in the workspace finds symbols', async () => {
      seed()
      searchWorkspaceSymbols.mockResolvedValue({ servers: 0, hits: [] })
      useUIStore.setState({ paletteOpen: true, paletteSeed: '%' })
      render(<CommandPalette />)
      expect(await screen.findByRole('status')).toHaveTextContent(
        'No running language server finds symbols in this workspace.',
      )
    })

    it('asks nothing for a workspace without panes', async () => {
      useUIStore.setState({ paletteOpen: true, paletteSeed: '%' })
      render(<CommandPalette />)
      expect(await screen.findByRole('status')).toBeInTheDocument()
      expect(searchWorkspaceSymbols).not.toHaveBeenCalled()
    })
  })
  describe('files in the workspace', () => {
    beforeEach(() => {
      vi.mocked(window.ostia.search.run).mockClear()
    })

    const outcome = (root: string, paths: string[]): SearchOutcome => ({
      ok: true,
      results: {
        root,
        names: paths.map((path) => ({ path, dir: false, positions: [0] })),
        files: [],
        pdfs: [],
        matches: 0,
        truncated: false,
      },
    })

    const seed = () =>
      useWorkspacesStore.setState({
        workspaces: [
          { id: 'w2', name: 'web', kind: 'terminal', workDir: '/src/web', state: 'idle' },
        ],
        activeWorkspaceId: 'w2',
      })

    it('opens on the file prefix, searches names only as the human types and keeps the order it is given', async () => {
      seed()
      vi.mocked(window.ostia.search.run).mockResolvedValue(
        outcome('/src/web', ['src/lib/greet.ts', 'README.md']),
      )
      render(<CommandPalette />)
      act(() => {
        void commands.exec('view.goToFile')
      })
      const input = await screen.findByRole('combobox')
      expect(input).toHaveValue('/')
      expect(await screen.findByRole('status')).toHaveTextContent('Type part of a file name')
      expect(window.ostia.search.run).not.toHaveBeenCalled()
      await userEvent.type(input, 'gre')

      const options = await screen.findAllByRole('option')
      expect(options).toHaveLength(2)
      expect(options[0]).toHaveTextContent('greet.ts')
      expect(options[0]).toHaveTextContent('src/lib')
      expect(options[1]).toHaveTextContent('README.md')
      await waitFor(() =>
        expect(window.ostia.search.run).toHaveBeenLastCalledWith({
          root: '/src/web',
          text: 'gre',
          regex: false,
          caseSensitive: false,
          wholeWord: false,
          includeIgnored: false,
          namesOnly: true,
        }),
      )
      expect(screen.queryByRole('option', { name: /Open Settings/ })).toBeNull()
    })

    it('opens the highlighted file on Enter and closes', async () => {
      seed()
      vi.mocked(window.ostia.search.run).mockResolvedValue(
        outcome('/src/web', ['src/lib/greet.ts', 'README.md']),
      )
      const openFile = vi.spyOn(useLayoutStore.getState(), 'openFile').mockImplementation(() => {})
      useUIStore.setState({ paletteOpen: true, paletteSeed: '/gre' })
      render(<CommandPalette />)
      await screen.findByRole('option', { name: /greet/ })
      await userEvent.type(screen.getByRole('combobox'), '{Enter}')

      expect(openFile).toHaveBeenCalledWith('w2', '/src/web/src/lib/greet.ts')
      expect(useUIStore.getState().paletteOpen).toBe(false)
    })

    it('opens the file that is clicked', async () => {
      seed()
      vi.mocked(window.ostia.search.run).mockResolvedValue(
        outcome('/src/web', ['src/lib/greet.ts', 'README.md']),
      )
      const openFile = vi.spyOn(useLayoutStore.getState(), 'openFile').mockImplementation(() => {})
      useUIStore.setState({ paletteOpen: true, paletteSeed: '/read' })
      render(<CommandPalette />)
      await userEvent.click(await screen.findByRole('option', { name: /README/ }))

      expect(openFile).toHaveBeenCalledWith('w2', '/src/web/README.md')
    })

    it('highlights the first hit again when the hits change', async () => {
      seed()
      vi.mocked(window.ostia.search.run).mockResolvedValue(outcome('/src/web', ['a.ts', 'b.ts']))
      useUIStore.setState({ paletteOpen: true, paletteSeed: '/t' })
      render(<CommandPalette />)
      await screen.findByRole('option', { name: /a\.ts/ })
      await userEvent.type(screen.getByRole('combobox'), '{ArrowDown}')
      expect(screen.getByRole('option', { name: /b\.ts/ })).toHaveAttribute('aria-selected', 'true')

      vi.mocked(window.ostia.search.run).mockResolvedValue(outcome('/src/web', ['c.ts', 'b.ts']))
      await userEvent.type(screen.getByRole('combobox'), 's')

      await screen.findByRole('option', { name: /c\.ts/ })
      await waitFor(() =>
        expect(screen.getByRole('option', { name: /c\.ts/ })).toHaveAttribute(
          'aria-selected',
          'true',
        ),
      )
    })

    it('says so when nothing matches, when the search fails and when there is no workspace', async () => {
      seed()
      vi.mocked(window.ostia.search.run).mockResolvedValue(outcome('/src/web', []))
      useUIStore.setState({ paletteOpen: true, paletteSeed: '/zzz' })
      render(<CommandPalette />)
      expect(await screen.findByRole('status')).toHaveTextContent('Nothing matches')
      cleanup()

      vi.mocked(window.ostia.search.run).mockResolvedValue({
        ok: false,
        error: 'failed',
        message: '',
      })
      render(<CommandPalette />)
      expect(await screen.findByRole('status')).toHaveTextContent('Could not search')
      cleanup()

      useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null })
      render(<CommandPalette />)
      expect(await screen.findByRole('status')).toHaveTextContent('Open a workspace')
    })

    it('lists the file prefix in the help', async () => {
      useUIStore.setState({ paletteOpen: true, paletteSeed: '?' })
      render(<CommandPalette />)
      expect(
        await screen.findByRole('option', { name: /Files in this workspace/ }),
      ).toBeInTheDocument()
    })
  })
})
