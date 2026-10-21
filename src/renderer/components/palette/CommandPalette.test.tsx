import '@testing-library/jest-dom/vitest'
import type { ExtensionInfo } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { zhHant } from '@shared/app/dict'
import type { SearchOutcome, SearchRequest } from '@shared/files/search'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { registerBuiltinCommands } from '@/commands/builtins'
import { syncExtensionCommands } from '@/commands/extensionBridge'
import { commands } from '@/commands/registry'
import { registerWindowCommands } from '@/commands/windowCommands'
import { languagesFrom } from '@/lib/extensions/languagePacks'
import { LINE_SEARCH_DELAY_MS } from '@/lib/files/workspaceFileSearch'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useUIStore } from '@/stores/app/uiStore'
import { useAssistStore } from '@/stores/assist/assistStore'
import { usePluginsStore } from '@/stores/extensions/pluginsStore'
import { useEditorRevealStore } from '@/stores/files/editorRevealStore'
import { newTerminalPane } from '@/stores/workspaces/layoutSeed'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWindowsStore } from '@/stores/workspaces/windowsStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { CommandPalette } from './CommandPalette'

const searchWorkspaceSymbols = vi.hoisted(() => vi.fn())
vi.mock('@/lib/lsp/client', () => ({ searchWorkspaceSymbols }))

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

  it('lists Reload Window and runs it through main, with no shortcut shown', async () => {
    act(() => registerWindowCommands(false))
    try {
      useUIStore.setState({ paletteOpen: true })
      render(<CommandPalette />)
      await userEvent.type(await screen.findByRole('combobox'), 'reload window')

      const option = await screen.findByRole('option', { name: /Reload Window/ })
      expect(option.querySelector('kbd')).toBeNull()
      await userEvent.click(option)

      await waitFor(() => expect(window.ostia.diagnostics.reloadWindow).toHaveBeenCalledTimes(1))
    } finally {
      act(() => {
        commands.unregister('window.reload')
        commands.unregister('window.new')
        commands.unregister('workspace.moveToNewWindow')
        commands.unregister('pane.moveToNewWindow')
      })
    }
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

    const slots = (option: HTMLElement): (string | undefined)[] => {
      const row = option.querySelector('[data-slot="palette-row"]') as HTMLElement
      return [...row.querySelectorAll<HTMLElement>('[data-slot]')].map((el) => el.dataset.slot)
    }

    const part = (option: HTMLElement, slot: string): HTMLElement =>
      option.querySelector(`[data-slot="palette-${slot}"]`) as HTMLElement

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

    const WITH_KEYS = [
      'palette-title',
      'palette-name',
      'palette-trailing',
      'palette-keys',
      'palette-meta',
    ]
    const WITHOUT_KEYS = ['palette-title', 'palette-name', 'palette-trailing', 'palette-meta']

    it('puts a command’s keycap and id at the right edge of the row, after its title', async () => {
      useUIStore.setState({ paletteOpen: true })
      render(<CommandPalette />)
      const option = await screen.findByRole('option', { name: /Open Settings/ })

      expect(slots(option)).toEqual(WITH_KEYS)
      expect(part(option, 'name')).toHaveTextContent('Open Settings')
      expect(part(option, 'keys').tagName).toBe('KBD')
      expect(part(option, 'title').nextElementSibling).toBe(part(option, 'trailing'))
      expect(part(option, 'trailing')).toHaveClass('ml-auto', 'shrink-0')
      expect(part(option, 'title')).toHaveClass('min-w-0')
      expect(part(option, 'keys').nextElementSibling).toBe(part(option, 'meta'))
      expect(part(option, 'meta')).toHaveClass('font-mono')
      expect(part(option, 'meta')).toHaveTextContent('app.openSettings')
    })

    it('shows the keycap dimmer than the title and never cuts it', async () => {
      useUIStore.setState({ paletteOpen: true })
      render(<CommandPalette />)
      const option = await screen.findByRole('option', { name: /Open Settings/ })

      expect(part(option, 'keys')).toHaveClass('text-muted-foreground', 'shrink-0')
      expect(part(option, 'name')).not.toHaveClass('text-muted-foreground', 'text-fg-muted')
    })

    it('puts the id at the right edge of a command without a keybinding', async () => {
      useUIStore.setState({ paletteOpen: true })
      render(<CommandPalette />)
      const options = await screen.findAllByRole('option')

      const unbound = options.find((o) => !o.querySelector('kbd')) as HTMLElement
      expect(unbound).toBeDefined()

      expect(slots(unbound)).toEqual(WITHOUT_KEYS)
      expect(part(unbound, 'meta').textContent).not.toBe('')
    })

    it('puts a workspace’s path after its name', async () => {
      seedPlaces()
      useUIStore.setState({ paletteOpen: true, paletteSeed: '@' })
      render(<CommandPalette />)
      const option = await screen.findByRole('option', { name: /payments/ })

      expect(slots(option)).toEqual([...WITHOUT_KEYS, 'tooltip-trigger'])
      expect(part(option, 'name')).toHaveTextContent('payments')
      expect(part(option, 'meta')).toHaveTextContent('/src/api')
    })

    it('marks a pinned or scratch workspace, names its project folder and still finds it by its worktree folder', async () => {
      seedPlaces()
      act(() =>
        useWorkspacesStore.setState({
          workspaces: [
            {
              id: 'w1',
              name: 'payments',
              kind: 'scratch',
              pinned: true,
              workDir: '/src/api-wt/refunds',
              projectDir: '/src/api',
              state: 'idle',
            },
          ],
          activeWorkspaceId: 'w1',
        }),
      )
      useUIStore.setState({ paletteOpen: true, paletteSeed: '@api-wt' })
      render(<CommandPalette />)
      const option = await screen.findByRole('option', { name: /payments/ })

      expect(part(option, 'meta')).toHaveTextContent('/src/api')
      expect(part(option, 'meta')).not.toHaveTextContent('api-wt')
      expect(within(option).getByText('Scratch')).toBeInTheDocument()
      expect(within(option).getByLabelText('Pinned')).toBeInTheDocument()
      expect(within(option).queryByLabelText('Sandboxed')).toBeNull()
      expect(within(option).queryByLabelText('Locked')).toBeNull()
    })

    it('puts a tab’s workspace after its title', async () => {
      seedPlaces()
      useUIStore.setState({ paletteOpen: true, paletteSeed: '#' })
      render(<CommandPalette />)
      const option = await screen.findByRole('option', { name: /Fix refunds/ })

      expect(slots(option)).toEqual(WITHOUT_KEYS)
      expect(part(option, 'name')).toHaveTextContent('Fix refunds')
      expect(part(option, 'meta')).toHaveTextContent('payments')
    })

    it('puts a file’s folder after its name', async () => {
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
      const option = await screen.findByRole('option', { name: /greet/ })

      expect(slots(option)).toEqual(WITHOUT_KEYS)
      expect(part(option, 'name')).toHaveTextContent('greet.ts')
      expect(part(option, 'meta')).toHaveTextContent('src/lib')
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
      const option = await screen.findByRole('option', { name: /billing/ })

      expect(slots(option)).toEqual(WITHOUT_KEYS)
      expect(part(option, 'name')).toHaveTextContent('billing')
      expect(part(option, 'meta')).toHaveTextContent('/src/billing')
    })

    it('shows an argument choice as its label alone', async () => {
      commands.register<{ argument?: string }, void>({
        id: 'test.layout-card',
        title: 'Test: Layout Card',
        argument: 'Card id',
        choices: async () => [{ value: 'shop-12', label: 'Fix checkout' }],
        run: vi.fn(),
      })
      try {
        useUIStore.setState({ paletteOpen: true })
        render(<CommandPalette />)
        await userEvent.type(await screen.findByRole('combobox'), 'Test: Layout Card{Enter}')
        const option = await screen.findByRole('option', { name: /Fix checkout/ })

        expect(slots(option)).toEqual(['palette-title', 'palette-name'])
        expect(part(option, 'name')).toHaveTextContent('Fix checkout')
      } finally {
        act(() => commands.unregister('test.layout-card'))
      }
    })

    it('truncates a long title before the right-aligned keycap and id', async () => {
      useUIStore.setState({ paletteOpen: true })
      render(<CommandPalette />)
      const option = await screen.findByRole('option', { name: /Open Settings/ })

      expect(part(option, 'title')).toHaveClass('min-w-0')
      expect(part(option, 'title')).not.toHaveClass('shrink-0')
      expect(part(option, 'name')).toHaveClass('truncate', 'min-w-0')
      expect(part(option, 'trailing')).toHaveClass('shrink-0', 'ml-auto')
      expect(part(option, 'meta')).toHaveClass('truncate', 'min-w-0', 'text-fg-muted')
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
      const option = await screen.findByRole('option', { name: /向右分割窗格/ })

      expect(slots(option)).toEqual(WITH_KEYS)
      expect(part(option, 'name')).toHaveTextContent('向右分割窗格')
      expect(part(option, 'meta')).toHaveTextContent('pane.splitRight')
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
      vi.mocked(window.ostia.languagePacks.load).mockReset()
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

    it('the Traditional Chinese pack is an extension: pick it, keep it across a restart', async () => {
      vi.mocked(window.ostia.languagePacks.load).mockResolvedValue([
        { extId: 'langpack-zh-hant', id: 'zh-Hant', label: '繁體中文', catalog: zhHant },
      ])
      await usePluginsStore.getState().loadLanguages()
      useSettingsStore.setState({ locale: 'zh-Hant' })
      useUIStore.setState({ paletteOpen: true })
      render(<CommandPalette />)
      const input = await screen.findByRole('combobox')

      await userEvent.click(input)
      await userEvent.paste('向右分割窗格')
      const option = (await screen.findByText('向右分割窗格')).closest('[role="option"]')
      expect(option).toHaveAttribute('aria-selected', 'true')
      expect(screen.queryByText('Split Pane Right')).toBeNull()
    })

    it('the Traditional Chinese pack is lost when its extension is disabled', async () => {
      const load = vi.mocked(window.ostia.languagePacks.load)
      load.mockResolvedValue([
        { extId: 'langpack-zh-hant', id: 'zh-Hant', label: '繁體中文', catalog: zhHant },
      ])
      await usePluginsStore.getState().loadLanguages()
      useSettingsStore.setState({ locale: 'zh-Hant' })
      useUIStore.setState({ paletteOpen: true })
      render(<CommandPalette />)
      expect(await screen.findByText('向右分割窗格')).toBeInTheDocument()

      load.mockResolvedValue([])
      await act(() => usePluginsStore.getState().loadLanguages())

      expect(await screen.findByText('Split Pane Right')).toBeInTheDocument()
      expect(screen.queryByText('向右分割窗格')).toBeNull()
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

  describe('the Git commit graph and Graphs', () => {
    const graphs: ExtensionInfo = {
      id: 'graphs',
      name: 'Graphs',
      version: '1.0.0',
      description: '',
      builtin: true,
      enabled: true,
      status: 'idle',
      requested: [],
      granted: [],
      unapproved: [],
      commands: [
        {
          id: 'open',
          title: 'Graphs: Open Panel',
          category: 'Graphs',
          palette: true,
          stdin: false,
          capabilities: [],
        },
        {
          id: 'validate',
          title: 'Check a graph file',
          palette: false,
          stdin: false,
          capabilities: [],
        },
      ],
      panel: { title: 'Graphs', icon: 'graph' },
      paneChips: [],
      workspaceChips: [],
      settings: [],
      settingValues: {},
      assist: [],
      secrets: [],
      secretsSet: [],
      connectionKinds: [],
      settingsPage: null,
      category: 'other',
      languages: [],
      languageServers: [],
      fileKinds: [],
      agentSkills: [],
      agentSkillProblems: [],
      agentHooks: [],
      iconThemes: [],
      keymaps: [],
    }

    afterEach(() => act(() => syncExtensionCommands([])))

    it('GRF-C149 typing graph shows Show Graph and the Graphs panel command once each, apart', async () => {
      syncExtensionCommands([graphs])
      syncExtensionCommands([graphs])
      useUIStore.setState({ paletteOpen: true })
      render(<CommandPalette />)

      await userEvent.type(await screen.findByRole('combobox'), 'graph')

      const panel = await screen.findAllByRole('option', { name: /Graphs: Open Panel/ })
      const showGraph = screen.getAllByRole('option', { name: /Show Graph/ })
      expect(panel).toHaveLength(1)
      expect(showGraph).toHaveLength(1)
      expect(showGraph[0]).not.toHaveTextContent('Graphs')
      expect(screen.queryByRole('option', { name: /Check a graph file/ })).toBeNull()
      expect(showGraph[0]).toHaveTextContent('git.showGraph')
      expect(panel[0]).toHaveTextContent('graphs.open')
      const rows = screen.getAllByRole('option').map((o) => o.textContent)
      expect(new Set(rows).size).toBe(rows.length)
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
      searchWorkspaceSymbols.mockImplementation(async (_panes: Set<string>, query: string) => ({
        servers: 1,
        hits: query === 'gre' ? [hit] : [],
      }))
      render(<CommandPalette />)
      act(() => {
        void commands.exec('view.goToWorkspaceSymbol')
      })
      const input = await screen.findByRole('combobox')
      expect(input).toHaveValue('%')
      await userEvent.type(input, 'gre')

      const option = await screen.findByRole('option', { name: /greet/ })
      expect(option).toHaveTextContent('lib/greet.ts:12')
      expect(searchWorkspaceSymbols).toHaveBeenLastCalledWith(new Set(['pane-3']), 'gre')
      expect(screen.queryByRole('option', { name: /Open Settings/ })).toBeNull()
    })

    it('puts a symbol’s container, then its place, after its name', async () => {
      seed()
      searchWorkspaceSymbols.mockResolvedValue({ servers: 1, hits: [hit] })
      useUIStore.setState({ paletteOpen: true, paletteSeed: '%gre' })
      render(<CommandPalette />)
      const option = await screen.findByRole('option', { name: /greet/ })
      const row = option.querySelector('[data-slot="palette-row"]') as HTMLElement

      expect([...row.children].map((el) => (el as HTMLElement).dataset.slot)).toEqual([
        'palette-title',
        'palette-detail',
        'palette-trailing',
      ])
      expect(row.children[0]).toHaveTextContent('greet')
      expect(row.children[1]).toHaveTextContent('lib')
      expect(row.children[2]).toHaveTextContent('lib/greet.ts:12')
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

  describe('search everywhere', () => {
    beforeEach(() => {
      vi.mocked(window.ostia.search.run).mockReset()
    })

    const hits = (paths: string[]): SearchOutcome => ({
      ok: true,
      results: {
        root: '/src/zoomer',
        names: paths.map((path) => ({ path, dir: false, positions: [0] })),
        files: [],
        pdfs: [],
        matches: 0,
        truncated: false,
      },
    })

    const seed = (): void => {
      useWorkspacesStore.setState({
        workspaces: [
          { id: 'w2', name: 'zoomer', kind: 'terminal', workDir: '/src/zoomer', state: 'idle' },
        ],
        activeWorkspaceId: 'w2',
      })
      useLayoutStore.setState({
        byWorkspace: {
          w2: {
            root: { type: 'pane', id: 'pane-3', title: 'zoom logs', kind: 'terminal' },
            activePaneId: 'pane-3',
            zoomedPaneId: null,
          },
        },
      })
      vi.mocked(window.ostia.search.run).mockResolvedValue(hits(['src/zoom.ts']))
    }

    const answerNamesOnly = (text: string): void => {
      vi.mocked(window.ostia.search.run).mockImplementation(async (req) =>
        hits(req.namesOnly && req.text === text ? ['src/zoom.ts'] : []),
      )
    }

    const headings = (): string[] =>
      [...document.querySelectorAll('[cmdk-group-heading]')].map((h) => h.textContent ?? '')

    const requests = (kind: 'namesOnly' | 'linesOnly'): string[] =>
      vi
        .mocked(window.ostia.search.run)
        .mock.calls.filter(([req]) => req[kind])
        .map(([req]) => req.text)

    it('opens from its command with its own title and placeholder', async () => {
      render(<CommandPalette />)
      act(() => {
        void commands.exec('palette.searchEverywhere')
      })
      expect(await screen.findByRole('dialog', { name: 'Search everywhere' })).toBeInTheDocument()
      expect(screen.getByRole('combobox')).toHaveAttribute(
        'placeholder',
        'Search commands, files, settings, workspaces and tabs…',
      )
    })

    it('puts commands, files, settings, workspaces and tabs in one list grouped by kind', async () => {
      seed()
      useUIStore.setState({ paletteOpen: true, paletteMode: 'everywhere' })
      render(<CommandPalette />)
      await userEvent.type(await screen.findByRole('combobox'), 'zoom')

      expect(await screen.findByRole('option', { name: /zoom\.ts/ })).toBeInTheDocument()
      expect(screen.getByRole('option', { name: /Zoom Pane/ })).toBeInTheDocument()
      expect(screen.getByRole('option', { name: /zoom logs/ })).toBeInTheDocument()
      expect(screen.getByRole('option', { name: /\/src\/zoomer/ })).toBeInTheDocument()
      expect(screen.getByRole('option', { name: /Search settings for “zoom”/ })).toBeInTheDocument()
      expect(headings()).toEqual(
        expect.arrayContaining([
          'Commands',
          'Files in this workspace',
          'Settings',
          'Workspaces',
          'Tabs',
        ]),
      )
      await waitFor(() => expect(requests('linesOnly').at(-1)).toBe('zoom'))
      expect(requests('namesOnly').at(-1)).toBe('zoom')
      expect(window.ostia.search.run).toHaveBeenCalledWith(
        expect.objectContaining({ root: '/src/zoomer', text: 'zoom', namesOnly: true }),
      )
      expect(window.ostia.search.run).toHaveBeenCalledWith(
        expect.objectContaining({ root: '/src/zoomer', text: 'zoom', linesOnly: true }),
      )
    })

    it('runs the command picked with Enter', async () => {
      useUIStore.setState({ paletteOpen: true, paletteMode: 'everywhere' })
      const exec = vi.spyOn(commands, 'exec').mockResolvedValue({ ok: true, result: undefined })
      render(<CommandPalette />)
      await userEvent.type(await screen.findByRole('combobox'), 'Open Settings{Enter}')

      expect(exec).toHaveBeenCalledWith('app.openSettings', undefined)
      expect(useUIStore.getState().paletteOpen).toBe(false)
    })

    it('lists a settings page only when it matches what was typed', async () => {
      useUIStore.setState({ paletteOpen: true, paletteMode: 'everywhere' })
      render(<CommandPalette />)
      const input = await screen.findByRole('combobox')

      await userEvent.type(input, 'zoom')
      expect(
        await screen.findByRole('option', { name: /Search settings for “zoom”/ }),
      ).toBeVisible()
      expect(screen.queryByRole('option', { name: /^Keyboard$/ })).toBeNull()
      expect(screen.queryByRole('option', { name: /^Appearance$/ })).toBeNull()
      expect(screen.queryByRole('group', { name: 'Settings' })).toBeNull()

      await userEvent.clear(input)
      await userEvent.type(input, 'keyb')
      expect(await screen.findByRole('option', { name: /^Keyboard$/ })).toBeInTheDocument()
      expect(screen.queryByRole('option', { name: /^Appearance$/ })).toBeNull()
      expect(screen.getByRole('group', { name: 'Settings' })).toBeInTheDocument()
    })

    it('opens a settings page', async () => {
      useUIStore.setState({ paletteOpen: true, paletteMode: 'everywhere' })
      render(<CommandPalette />)
      fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'keyboard' } })
      await userEvent.click(await screen.findByRole('option', { name: /^Keyboard$/ }))
      expect(useUIStore.getState()).toMatchObject({
        paletteOpen: false,
        settingsActive: true,
        settingsSection: 'keyboard',
        settingsQuery: '',
      })
    })

    it('opens the settings search with what was typed', async () => {
      useUIStore.setState({ paletteOpen: true, paletteMode: 'everywhere' })
      render(<CommandPalette />)
      fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'font size' } })
      await userEvent.click(
        await screen.findByRole('option', { name: /Search settings for “font size”/ }),
      )
      expect(useUIStore.getState()).toMatchObject({
        paletteOpen: false,
        settingsActive: true,
        settingsQuery: 'font size',
      })
    })

    it('opens from the palette chord’s command filtered to commands, and on everything once the prefix is removed', async () => {
      seed()
      render(<CommandPalette />)
      act(() => {
        void commands.exec('palette.toggle')
      })
      const input = await screen.findByRole('combobox')

      expect(await screen.findByRole('dialog', { name: 'Command palette' })).toBeInTheDocument()
      expect(input).toHaveValue('>')
      expect(screen.getByRole('option', { name: /Zoom Pane/ })).toBeInTheDocument()
      expect(screen.queryByRole('option', { name: /zoom logs/ })).toBeNull()
      expect(headings()).not.toContain('Workspaces')

      await userEvent.type(input, 'zoom')
      expect(input).toHaveValue('>zoom')
      expect(screen.getByRole('option', { name: /Zoom Pane/ })).toBeInTheDocument()
      expect(screen.queryByRole('option', { name: /zoom logs/ })).toBeNull()

      await userEvent.clear(input)
      expect(await screen.findByRole('option', { name: /zoom logs/ })).toBeInTheDocument()
      expect(headings()).toEqual(expect.arrayContaining(['Workspaces', 'Tabs']))
    })

    it('offers to search the text of files for what was typed and opens the Files search with it', async () => {
      seed()
      useUIStore.setState({ paletteOpen: true, paletteMode: 'everywhere' })
      render(<CommandPalette />)
      const input = await screen.findByRole('combobox')
      expect(screen.queryByRole('option', { name: /Search text in files/ })).toBeNull()

      await userEvent.type(input, 'zoom level')
      await userEvent.click(
        await screen.findByRole('option', { name: 'Search text in files for “zoom level”' }),
      )

      expect(useUIStore.getState()).toMatchObject({
        paletteOpen: false,
        filesOpen: true,
        filesSearchFocus: true,
        filesSearchQuery: 'zoom level',
      })
      act(() => useUIStore.setState({ filesOpen: false, filesSearchFocus: false }))
    })

    const lines = (path: string, texts: string[]): SearchOutcome => ({
      ok: true,
      results: {
        root: '/src/zoomer',
        names: [],
        files: [
          {
            path,
            matches: texts.map((text, index) => ({
              line: index + 4,
              column: 3,
              text,
              ranges: [[2, 6]] as [number, number][],
            })),
          },
        ],
        pdfs: [],
        matches: texts.length,
        truncated: false,
      },
    })

    const answerBy = (
      answer: (req: SearchRequest) => SearchOutcome | Promise<SearchOutcome>,
    ): void => {
      vi.mocked(window.ostia.search.run).mockImplementation(async (req) => answer(req))
    }

    it('opens a file at the line, or the line and column, typed after its name', async () => {
      seed()
      useUIStore.setState({ paletteOpen: true, paletteMode: 'everywhere' })
      render(<CommandPalette />)
      const input = await screen.findByRole('combobox')

      answerNamesOnly('zoom.ts')
      await userEvent.type(input, 'zoom.ts:12')
      await userEvent.click(await screen.findByRole('option', { name: /^zoom\.ts/ }))

      expect(requests('namesOnly').at(-1)).toBe('zoom.ts')
      expect(useEditorRevealStore.getState().pending['/src/zoomer/src/zoom.ts']).toMatchObject({
        line: 12,
        column: 1,
      })
      expect(useUIStore.getState().paletteOpen).toBe(false)

      act(() => useUIStore.getState().openPalette('everywhere'))
      answerNamesOnly('zoom')
      await userEvent.type(await screen.findByRole('combobox'), 'zoom:12:5')
      await userEvent.click(await screen.findByRole('option', { name: /^zoom\.ts/ }))

      expect(requests('namesOnly').at(-1)).toBe('zoom')
      expect(useEditorRevealStore.getState().pending['/src/zoomer/src/zoom.ts']).toMatchObject({
        line: 12,
        column: 5,
      })
      act(() => useEditorRevealStore.setState({ pending: {} }))
    })

    it('opens a file at a line from the file prefix too', async () => {
      seed()
      useUIStore.setState({ paletteOpen: true, paletteSeed: '/zoom:7' })
      render(<CommandPalette />)
      await userEvent.click(await screen.findByRole('option', { name: /^zoom\.ts/ }))

      expect(useEditorRevealStore.getState().pending['/src/zoomer/src/zoom.ts']).toMatchObject({
        line: 7,
      })
      act(() => useEditorRevealStore.setState({ pending: {} }))
    })

    it('lists the matching text lines as file, line number and line, and opens the file there', async () => {
      seed()
      answerBy((req) =>
        req.linesOnly ? lines('src/level.ts', ['  zoomLevel = 2', '  return zoomLevel']) : hits([]),
      )
      useUIStore.setState({ paletteOpen: true, paletteMode: 'everywhere' })
      render(<CommandPalette />)
      await userEvent.type(await screen.findByRole('combobox'), 'zoomLevel')

      const first = await screen.findByRole('option', { name: /level\.ts:4/ })
      expect(first).toHaveTextContent('level.ts:4zoomLevel = 2')
      expect(screen.getByRole('option', { name: /level\.ts:5/ })).toHaveTextContent(
        'return zoomLevel',
      )
      expect(headings()).toContain('Text in this workspace')
      expect(
        screen.getByRole('option', { name: 'Search text in files for “zoomLevel”' }),
      ).toBeInTheDocument()

      await userEvent.click(first)

      expect(useEditorRevealStore.getState().pending['/src/zoomer/src/level.ts']).toMatchObject({
        line: 4,
        column: 3,
      })
      expect(useUIStore.getState().paletteOpen).toBe(false)
      act(() => useEditorRevealStore.setState({ pending: {} }))
    })

    it('searches text only for the last thing typed, and drops an answer that a newer search replaced', async () => {
      seed()
      const pending: { text: string; settle: (outcome: SearchOutcome) => void }[] = []
      answerBy((req) =>
        req.linesOnly
          ? new Promise<SearchOutcome>((settle) => pending.push({ text: req.text, settle }))
          : hits([]),
      )
      useUIStore.setState({ paletteOpen: true, paletteMode: 'everywhere' })
      render(<CommandPalette />)
      const input = await screen.findByRole('combobox')
      const typeAtOnce = (...values: string[]): void => {
        for (const value of values) fireEvent.change(input, { target: { value } })
      }

      typeAtOnce('ne', 'nee', 'need')
      await waitFor(() => expect(pending).toHaveLength(1))
      expect(requests('linesOnly')).toEqual(['need'])

      typeAtOnce('needl', 'needle')
      await waitFor(() => expect(pending).toHaveLength(2))
      expect(requests('linesOnly')).toEqual(['need', 'needle'])

      await act(async () => pending[0].settle(lines('old.ts', ['  need'])))
      expect(screen.queryByRole('option', { name: /old\.ts/ })).toBeNull()

      await act(async () => pending[1].settle(lines('new.ts', ['  needle'])))
      expect(await screen.findByRole('option', { name: /new\.ts:4/ })).toBeInTheDocument()
      expect(screen.queryByRole('option', { name: /old\.ts/ })).toBeNull()
    })

    it('searches no text for a single character or outside Search Everywhere, and shows no group without lines', async () => {
      seed()
      answerBy((req) => (req.linesOnly ? lines('src/level.ts', []) : hits(['src/zoom.ts'])))
      useUIStore.setState({ paletteOpen: true, paletteMode: 'everywhere' })
      render(<CommandPalette />)
      const input = await screen.findByRole('combobox')

      await userEvent.type(input, 'z')
      expect(await screen.findByRole('option', { name: /zoom\.ts/ })).toBeInTheDocument()
      await new Promise((resolve) => setTimeout(resolve, LINE_SEARCH_DELAY_MS + 50))
      expect(requests('linesOnly')).toEqual([])

      await userEvent.type(input, 'o')
      await waitFor(() => expect(requests('linesOnly')).toEqual(['zo']))
      expect(headings()).not.toContain('Text in this workspace')

      await userEvent.clear(input)
      await userEvent.type(input, '>zoom')
      await new Promise((resolve) => setTimeout(resolve, LINE_SEARCH_DELAY_MS + 50))
      expect(requests('linesOnly')).toEqual(['zo'])
    })

    const PALETTE_TOGGLE_KEY = { key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true }

    const keysOutside = (): ReturnType<typeof vi.fn> => {
      const outside = vi.fn()
      window.addEventListener('keydown', outside)
      onTestFinished(() => window.removeEventListener('keydown', outside))
      return outside
    }

    it.each(['', '>', '@', '#', '/', '%', '?'])(
      'closes on the palette chord from the %j prefix',
      async (typed) => {
        seed()
        const outside = keysOutside()
        render(<CommandPalette />)
        act(() => useUIStore.getState().openPalette('search', typed))
        const input = await screen.findByRole('combobox')
        await waitFor(() => expect(input).toHaveValue(typed))
        fireEvent.keyDown(input, PALETTE_TOGGLE_KEY)
        expect(useUIStore.getState().paletteOpen).toBe(false)
        await waitFor(() => expect(screen.queryByRole('combobox')).toBeNull())
        expect(outside).not.toHaveBeenCalled()
      },
    )

    it('closes on F1 from Search Everywhere', async () => {
      seed()
      const outside = keysOutside()
      render(<CommandPalette />)
      act(() => useUIStore.getState().openPalette('everywhere'))
      fireEvent.keyDown(await screen.findByRole('combobox'), { key: 'F1', code: 'F1' })
      expect(useUIStore.getState().paletteOpen).toBe(false)
      await waitFor(() => expect(screen.queryByRole('combobox')).toBeNull())
      expect(outside).not.toHaveBeenCalled()
    })

    it('closes on the palette chord from Ask, and the chord never reaches the window', async () => {
      seed()
      const outside = keysOutside()
      useAssistStore.setState({
        availability: {
          chat: {
            extId: 'assistant',
            name: 'Assistant',
            label: 'model-runtime · gemma',
            ref: { extId: 'assistant' },
          },
        },
      })
      onTestFinished(() => useAssistStore.setState({ availability: {} }))
      render(<CommandPalette />)
      act(() => useUIStore.getState().openPalette('ask'))
      const question = await screen.findByRole('combobox', { name: 'Your question' })
      fireEvent.keyDown(question, PALETTE_TOGGLE_KEY)
      expect(useUIStore.getState().paletteOpen).toBe(false)
      expect(outside).not.toHaveBeenCalled()
    })

    it('closes on the palette chord from a command’s value step', async () => {
      seed()
      const outside = keysOutside()
      commands.register<{ argument?: string }, void>({
        id: 'test.toggle-card',
        title: 'Test: Toggle Card',
        argument: 'Card id',
        run: vi.fn(),
      })
      onTestFinished(() => commands.unregister('test.toggle-card'))
      render(<CommandPalette />)
      act(() => useUIStore.getState().openPalette('search'))
      await userEvent.click(await screen.findByRole('option', { name: /Test: Toggle Card/ }))
      fireEvent.keyDown(screen.getByPlaceholderText('Card id'), PALETTE_TOGGLE_KEY)
      expect(useUIStore.getState().paletteOpen).toBe(false)
      expect(outside).not.toHaveBeenCalled()
    })

    it('words the search-text row in Traditional Chinese', async () => {
      usePluginsStore.setState({
        languages: languagesFrom([
          { extId: 'langpack-zh-hant', id: 'zh-Hant', label: '繁體中文', catalog: zhHant },
        ]),
      })
      useSettingsStore.setState({ locale: 'zh-Hant' })
      useUIStore.setState({ paletteOpen: true, paletteMode: 'everywhere' })
      try {
        render(<CommandPalette />)
        await userEvent.type(await screen.findByRole('combobox'), 'zoom')

        expect(
          await screen.findByRole('option', { name: '在檔案中搜尋文字「zoom」' }),
        ).toBeInTheDocument()
      } finally {
        act(() => {
          usePluginsStore.setState({ languages: languagesFrom([]) })
          useSettingsStore.setState({ locale: 'en' })
        })
      }
    })

    it('leaves files and settings out of the command palette', async () => {
      seed()
      useUIStore.setState({ paletteOpen: true })
      render(<CommandPalette />)
      await userEvent.type(await screen.findByRole('combobox'), 'zoom')

      expect(await screen.findByRole('option', { name: /Zoom Pane/ })).toBeInTheDocument()
      expect(screen.queryByRole('option', { name: /Search settings/ })).toBeNull()
      expect(screen.queryByRole('option', { name: /Search text in files/ })).toBeNull()
      expect(headings()).not.toContain('Settings')
      expect(window.ostia.search.run).not.toHaveBeenCalled()
    })
  })

  describe('Escape', () => {
    afterEach(() => act(() => commands.unregister('test.escape-card')))

    const closedByEscape = async (state: string): Promise<void> => {
      await userEvent.keyboard('{Escape}')
      expect(useUIStore.getState().paletteOpen, state).toBe(false)
      await waitFor(() => expect(screen.queryByRole('combobox'), state).toBeNull())
    }

    it.each(['>', '', '@', '#', '/', '%', '?'])(
      'Escape closes the palette from the %j prefix',
      async (typed) => {
        render(<CommandPalette />)
        act(() => useUIStore.getState().openPalette('search', typed))
        const input = await screen.findByRole('combobox')
        await waitFor(() => expect(input).toHaveValue(typed))
        await waitFor(() => expect(input).toHaveFocus())
        await closedByEscape(`prefix "${typed}"`)
      },
    )

    it('Escape closes Search Everywhere after typing', async () => {
      render(<CommandPalette />)
      act(() => useUIStore.getState().openPalette('everywhere'))
      await userEvent.type(await screen.findByRole('combobox'), 'needle')
      await closedByEscape('Search Everywhere after typing')
    })

    it('Escape closes the palette from a command’s value step', async () => {
      render(<CommandPalette />)
      act(() => {
        commands.register<{ argument?: string }, void>({
          id: 'test.escape-card',
          title: 'Test: Escape Card',
          argument: 'Card id',
          run: vi.fn(),
        })
        useUIStore.getState().openPalette('search')
      })
      await userEvent.click(await screen.findByRole('option', { name: /Test: Escape Card/ }))
      expect(screen.getByPlaceholderText('Card id')).toHaveFocus()
      await closedByEscape('a command’s value step')
    })

    it('keeps the repeats of a held Escape from the window once it closed the palette, and lets the next press through', async () => {
      const outside = vi.fn()
      window.addEventListener('keydown', outside)
      onTestFinished(() => window.removeEventListener('keydown', outside))
      render(<CommandPalette />)
      act(() => useUIStore.getState().openPalette('search'))
      fireEvent.keyDown(await screen.findByRole('combobox'), { key: 'Escape', code: 'Escape' })
      expect(useUIStore.getState().paletteOpen).toBe(false)
      await waitFor(() => expect(screen.queryByRole('combobox')).toBeNull())

      outside.mockClear()
      fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape', repeat: true })
      fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape', repeat: true })
      expect(outside).not.toHaveBeenCalled()

      fireEvent.keyUp(document.body, { key: 'Escape', code: 'Escape' })
      fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' })
      expect(outside).toHaveBeenCalledTimes(1)
    })

    it.each(['search', 'everywhere'] as const)(
      'Escape while an input method is composing in the %s palette closes it, and the next Escape in a reopened palette closes it too',
      async (mode) => {
        render(<CommandPalette />)
        act(() => useUIStore.getState().openPalette(mode))
        const input = await screen.findByRole('combobox')
        fireEvent.change(input, { target: { value: 'ni' } })
        fireEvent.keyDown(input, { key: 'Process', code: 'Escape', keyCode: 229 })
        expect(useUIStore.getState().paletteOpen).toBe(false)
        await waitFor(() => expect(screen.queryByRole('combobox')).toBeNull())

        act(() => useUIStore.getState().openPalette(mode))
        const reopened = await screen.findByRole('combobox')
        expect(reopened).not.toHaveValue(expect.stringMatching(/ni$/))
        await waitFor(() => expect(reopened).toHaveFocus())
        await closedByEscape(`${mode}, reopened`)
      },
    )
  })

  describe('focus after closing', () => {
    let terminal: HTMLTextAreaElement

    beforeEach(() => {
      terminal = document.createElement('textarea')
      document.body.append(terminal)
      onTestFinished(() => terminal.remove())
      terminal.focus()
      const first = newTerminalPane()
      const second = newTerminalPane()
      useWorkspacesStore.setState({ activeWorkspaceId: 'w' })
      const layout = (pane: typeof first) => ({
        byWorkspace: { w: { root: pane, activePaneId: pane.id, zoomedPaneId: null } },
      })
      useLayoutStore.setState(layout(first))
      onTestFinished(() => useLayoutStore.setState(layout(second)))
    })

    const switchPane = (): void => {
      const pane = newTerminalPane()
      useLayoutStore.setState({
        byWorkspace: { w: { root: pane, activePaneId: pane.id, zoomedPaneId: null } },
      })
    }

    const closers: [string, () => Promise<void> | void][] = [
      ['Escape', () => userEvent.keyboard('{Escape}')],
      ['the palette chord', () => act(() => useUIStore.getState().togglePalette())],
    ]

    it.each(closers)('%s returns focus when the keyboard pane is unchanged', async (_, close) => {
      render(<CommandPalette />)
      act(() => useUIStore.getState().openPalette())
      await screen.findByRole('combobox')
      await close()
      await waitFor(() => expect(terminal).toHaveFocus())
    })

    it.each(closers)('%s leaves focus alone when the keyboard pane changed', async (_, close) => {
      render(<CommandPalette />)
      act(() => useUIStore.getState().openPalette())
      await screen.findByRole('combobox')
      act(switchPane)
      await close()
      await waitFor(() => expect(screen.queryByRole('combobox')).toBeNull())
      expect(terminal).not.toHaveFocus()
    })
  })
})
