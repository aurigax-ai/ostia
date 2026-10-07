import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { languagesFrom } from '../lib/languagePacks'
import { useExtensionsStore } from '../stores/extensionsStore'
import { usePluginsStore } from '../stores/pluginsStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { SettingsPanel } from './SettingsPanel'

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

function renderSettings(): void {
  useUIStore.setState({ settingsActive: true, settingsTabOpen: true })
  render(<SettingsPanel />)
}

describe('SettingsPanel', () => {
  let settingsInit: ReturnType<typeof useSettingsStore.getState>
  let uiInit: ReturnType<typeof useUIStore.getState>
  let pluginsInit: ReturnType<typeof usePluginsStore.getState>
  let extensionsInit: ReturnType<typeof useExtensionsStore.getState>

  beforeAll(() => {
    Object.assign(window, {
      queryLocalFonts: async () =>
        ['Inter Variable', 'JetBrains Mono', 'JetBrainsMono Nerd Font Mono'].map((family) => ({
          family,
        })),
    })
    settingsInit = useSettingsStore.getState()
    uiInit = useUIStore.getState()
    pluginsInit = usePluginsStore.getState()
    extensionsInit = useExtensionsStore.getState()
  })

  afterEach(() => {
    cleanup()
    useSettingsStore.setState(settingsInit, true)
    useUIStore.setState(uiInit, true)
    usePluginsStore.setState(pluginsInit, true)
    useExtensionsStore.setState(extensionsInit, true)
    vi.restoreAllMocks()
  })

  it('renders the settings surface with its section nav and the Appearance pane by default', () => {
    renderSettings()

    expect(screen.getByRole('region', { name: 'Settings' })).toBeInTheDocument()

    for (const name of ['Appearance', 'Terminal', 'Files', 'Language', 'About']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument()
    }
    expect(screen.getByRole('button', { name: 'Open settings file' })).toBeInTheDocument()

    expect(screen.getByRole('heading', { level: 2, name: 'Appearance' })).toBeInTheDocument()
    expect(screen.getByText('Ostia theme')).toBeInTheDocument()
    expect(screen.getByText('UI font')).toBeInTheDocument()
    expect(screen.getByText('Terminal font')).toBeInTheDocument()
    expect(screen.getByText('Editor font')).toBeInTheDocument()
  })

  it('groups the section nav under headings, in order, so related pages sit together', () => {
    renderSettings()

    const headings = screen.getByRole('region', { name: 'Settings' }).querySelectorAll('nav h3')
    expect([...headings].map((h) => h.textContent)).toEqual([
      'General',
      'Terminal',
      'Workspace',
      'Agents',
      'Editor and browser',
      'Privacy and security',
      'Extensions and more',
    ])
    const inGroup = (group: string) =>
      within(screen.getByRole('list', { name: group }))
        .getAllByRole('button')
        .map((b) => b.textContent)
    expect(inGroup('General')).toEqual(['Appearance', 'Language', 'Notifications', 'Sync'])
    expect(inGroup('Terminal')).toEqual(['Terminal', 'Prompt', 'Keyboard', 'Panes'])
    expect(inGroup('Editor and browser')).toEqual(['Editor', 'Languages', 'Browser'])
  })

  it('returns null while Settings is not the active view', () => {
    useUIStore.setState({ settingsActive: false })
    const { container } = render(<SettingsPanel />)

    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByRole('region', { name: 'Settings' })).not.toBeInTheDocument()
  })

  it('sources theme options from pluginsStore — a custom theme appears and selecting it calls setTheme', async () => {
    usePluginsStore.setState((s) => ({
      themes: [
        ...s.themes,
        {
          id: 'test-theme',
          name: 'Test Theme',
          appearance: 'dark',
          colorScheme: 'nord',
          tokens: s.themes[0].tokens,
        },
      ],
    }))
    const setTheme = vi.spyOn(useSettingsStore.getState(), 'setTheme').mockImplementation(() => {})
    renderSettings()
    const user = userEvent.setup()

    await user.click(screen.getByRole('combobox', { name: 'Ostia theme' }))

    for (const name of ['One Dark Vivid', 'Dracula', 'Test Theme']) {
      expect(await screen.findByRole('option', { name })).toBeInTheDocument()
    }

    await user.click(screen.getByRole('option', { name: 'Test Theme' }))

    expect(setTheme).toHaveBeenCalledWith('test-theme')
  })

  it('reflects the current theme in the theme picker trigger', () => {
    useSettingsStore.setState((s) => ({ appearance: { ...s.appearance, theme: 'oxocarbon' } }))
    renderSettings()

    expect(screen.getByRole('combobox', { name: 'Ostia theme' })).toHaveTextContent('Oxocarbon')
  })

  it('changes the display language via the Language section, calling setLocale', async () => {
    const setLocale = vi
      .spyOn(useSettingsStore.getState(), 'setLocale')
      .mockImplementation(() => {})
    usePluginsStore.setState({
      languages: languagesFrom([
        { extId: 'langpack-zh-hant', id: 'zh-Hant', label: '繁體中文', catalog: {} },
      ]),
    })
    renderSettings()
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'Language' }))
    await user.click(screen.getByRole('combobox', { name: 'Display language' }))

    expect(await screen.findByRole('option', { name: 'English' })).toBeInTheDocument()
    await user.click(screen.getByRole('option', { name: '繁體中文' }))

    expect(setLocale).toHaveBeenCalledWith('zh-Hant')
  })

  it('edits every Files tree option from Settings → Files', async () => {
    useExtensionsStore.setState({
      list: [
        {
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
        },
      ],
    })
    renderSettings()
    const user = userEvent.setup()
    const files = () => useSettingsStore.getState().files

    await user.click(screen.getByRole('button', { name: 'Files' }))

    await user.click(screen.getByRole('switch', { name: 'Compact folders' }))
    expect(files().compactFolders).toBe(false)
    await user.click(screen.getByRole('switch', { name: 'Show hidden files' }))
    expect(files().showExcluded).toBe(true)

    const hideDotfiles = screen.getByRole('switch', { name: 'Hide dotfiles' })
    expect(hideDotfiles).not.toBeChecked()
    await user.click(hideDotfiles)
    expect(files().exclude).toContain('**/.*')
    expect(screen.getByRole('list', { name: 'Hidden file patterns' })).toHaveTextContent('**/.*')
    await user.click(hideDotfiles)
    expect(files().exclude).not.toContain('**/.*')

    const excluded = screen.getByRole('list', { name: 'Hidden file patterns' })
    expect(excluded).toHaveTextContent('**/.git')
    await user.type(
      screen.getByRole('textbox', { name: 'Pattern, e.g. **/dist' }),
      '**/dist{Enter}',
    )
    expect(files().exclude).toContain('**/dist')
    await user.click(screen.getByRole('button', { name: 'Remove **/.git' }))
    expect(files().exclude).not.toContain('**/.git')

    const rules = screen.getByRole('list', { name: 'Nesting rules' })
    expect(rules).toHaveTextContent('Cargo.toml')
    await user.type(screen.getByRole('textbox', { name: 'Parent, e.g. *.ts' }), '*.go')
    await user.type(
      screen.getByRole('textbox', { name: 'Children, e.g. ${capture}.test.ts' }),
      '${{capture}_test.go',
    )
    await user.click(screen.getAllByRole('button', { name: 'Add' })[1])
    expect(files().nesting.patterns['*.go']).toBe('${capture}_test.go')
    await user.click(screen.getByRole('button', { name: 'Remove Cargo.toml' }))
    expect(files().nesting.patterns['Cargo.toml']).toBeUndefined()
    await user.click(screen.getByRole('button', { name: 'Restore default rules' }))
    expect(files().nesting.patterns['Cargo.toml']).toBe('Cargo.lock')
    await user.click(screen.getByRole('switch', { name: 'Nest related files' }))
    expect(files().nesting.enabled).toBe(false)
    expect(screen.queryByRole('list', { name: 'Nesting rules' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('combobox', { name: 'Folder placement' }))
    await user.click(await screen.findByRole('option', { name: 'Folders and files mixed' }))
    expect(files().sortOrder).toBe('mixed')
    await user.click(screen.getByRole('combobox', { name: 'Sort by' }))
    await user.click(await screen.findByRole('option', { name: 'By type' }))
    expect(files().sortBy).toBe('type')
    await user.click(screen.getByRole('combobox', { name: 'File icon theme' }))
    await user.click(await screen.findByRole('option', { name: 'Fixture Icons' }))
    expect(files().iconTheme).toBe('fixture-icons')
  }, 15_000)

  it('switches the input mode (Terminal section) via setBehavior', async () => {
    const setBehavior = vi
      .spyOn(useSettingsStore.getState(), 'setBehavior')
      .mockImplementation(() => {})
    renderSettings()
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'Terminal' }))
    expect(screen.getByRole('heading', { level: 3, name: 'Input' })).toBeInTheDocument()
    const select = screen.getByRole('combobox', { name: 'Input mode' })
    expect(select).toHaveTextContent('Terminal')
    await user.click(select)
    await user.click(await screen.findByRole('option', { name: 'Input editor' }))

    expect(setBehavior).toHaveBeenCalledWith({ inputMode: 'editor' })
  })

  it('opens the Prompt page from the Terminal page’s Edit prompt button', async () => {
    renderSettings()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Terminal' }))
    await user.click(screen.getByRole('button', { name: 'Edit prompt' }))
    expect(screen.getByRole('heading', { level: 2, name: 'Prompt' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Prompt' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('combobox', { name: 'Prompt style' })).toBeInTheDocument()
  })

  it('changes the cursor style (Terminal section) via setBehavior', async () => {
    const setBehavior = vi
      .spyOn(useSettingsStore.getState(), 'setBehavior')
      .mockImplementation(() => {})
    renderSettings()
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'Terminal' }))
    await user.click(screen.getByRole('combobox', { name: 'Cursor style' }))

    for (const name of ['Block', 'Underline', 'Bar']) {
      expect(await screen.findByRole('option', { name })).toBeInTheDocument()
    }
    await user.click(screen.getByRole('option', { name: 'Underline' }))

    expect(setBehavior).toHaveBeenCalledWith({ cursorStyle: 'underline' })
  })

  it('toggles Cursor blink (Terminal section) via setBehavior, reflecting the seeded value', async () => {
    useSettingsStore.setState((s) => ({ behavior: { ...s.behavior, cursorBlink: true } }))
    const setBehavior = vi
      .spyOn(useSettingsStore.getState(), 'setBehavior')
      .mockImplementation(() => {})
    renderSettings()
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'Terminal' }))
    const blink = screen.getByRole('switch', { name: 'Cursor blink' })
    expect(blink).toBeChecked()

    await user.click(blink)

    expect(setBehavior).toHaveBeenCalledWith({ cursorBlink: false })
  })

  it('picks a font family by searching the installed fonts', async () => {
    const setSurfaceFont = vi
      .spyOn(useSettingsStore.getState(), 'setSurfaceFont')
      .mockImplementation(() => {})
    renderSettings()
    const user = userEvent.setup()

    const family = screen.getByRole('combobox', { name: 'Terminal font, Family' })
    await user.click(family)
    await user.clear(family)
    await user.type(family, 'nerd')
    expect(screen.queryByRole('option', { name: 'Inter Variable' })).toBeNull()
    await user.click(await screen.findByRole('option', { name: 'JetBrainsMono Nerd Font Mono' }))

    expect(setSurfaceFont).toHaveBeenCalledWith('terminal', {
      family: 'JetBrainsMono Nerd Font Mono',
    })
  })

  it('warns when the chosen font is not installed', async () => {
    renderSettings()
    const user = userEvent.setup()
    await user.click(screen.getByRole('combobox', { name: 'Terminal font, Family' }))
    expect(await screen.findByText('Not installed; a fallback font is used')).toBeInTheDocument()
  })

  it('changes a font weight via setSurfaceFont', async () => {
    const setSurfaceFont = vi
      .spyOn(useSettingsStore.getState(), 'setSurfaceFont')
      .mockImplementation(() => {})
    renderSettings()
    const user = userEvent.setup()
    await user.click(screen.getByRole('combobox', { name: 'UI font, Weight' }))
    await user.click(await screen.findByRole('option', { name: '600' }))
    expect(setSurfaceFont).toHaveBeenCalledWith('ui', { weight: 600 })
  })

  it('changes a font size via setSurfaceFont, clamping to the 8–32 range', () => {
    const setSurfaceFont = vi
      .spyOn(useSettingsStore.getState(), 'setSurfaceFont')
      .mockImplementation(() => {})
    renderSettings()
    const sizeInput = screen.getByRole('spinbutton', { name: 'Terminal font, Size' })

    fireEvent.change(sizeInput, { target: { value: '18' } })
    expect(setSurfaceFont).toHaveBeenLastCalledWith('terminal', { size: 18 })

    fireEvent.change(sizeInput, { target: { value: '99' } })
    expect(setSurfaceFont).toHaveBeenLastCalledWith('terminal', { size: 32 })

    fireEvent.change(sizeInput, { target: { value: '1' } })
    expect(setSurfaceFont).toHaveBeenLastCalledWith('terminal', { size: 8 })
  })

  it('reflects the current appearance settings in the controls', () => {
    useSettingsStore.setState((s) => ({
      appearance: {
        ...s.appearance,
        theme: 'dracula',
        ui: { family: 'Comic Code', size: 20, weight: 500 },
      },
    }))
    renderSettings()

    expect(screen.getByRole('combobox', { name: 'Ostia theme' })).toHaveTextContent('Dracula')
    expect(screen.getByRole('combobox', { name: 'UI font, Family' })).toHaveValue('Comic Code')
    expect(screen.getByRole('combobox', { name: 'UI font, Weight' })).toHaveTextContent('500')
    expect(screen.getByRole('spinbutton', { name: 'UI font, Size' })).toHaveValue(20)
  })

  it('shows the full build version on About and copies it', async () => {
    vi.mocked(window.ostia.info).mockResolvedValue({
      name: 'Ostia',
      version: '0.5.9-rc.3+sha.1a2b3c.dirty',
      platform: 'linux',
      hostName: 'devbox',
      home: '/home/me',
    })
    renderSettings()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'About' }))
    expect(await screen.findByText('v0.5.9-rc.3+sha.1a2b3c.dirty')).toBeInTheDocument()
    expect(screen.getByText(`Copyright ${new Date().getFullYear()} Ostia`)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Copy version' }))
    expect(await navigator.clipboard.readText()).toBe('v0.5.9-rc.3+sha.1a2b3c.dirty')
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })

  it('opens the log folder from About', async () => {
    renderSettings()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'About' }))
    await user.click(await screen.findByRole('button', { name: 'Open log folder' }))
    expect(window.ostia.diagnostics.openLogFolder).toHaveBeenCalled()
  })

  it('toggles notification kinds and sidebar details from their pages', async () => {
    const setNotifications = vi
      .spyOn(useSettingsStore.getState(), 'setNotifications')
      .mockImplementation(() => {})
    const setSidebar = vi
      .spyOn(useSettingsStore.getState(), 'setSidebar')
      .mockImplementation(() => {})
    renderSettings()
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'Notifications' }))
    await user.click(screen.getByRole('switch', { name: 'Agent finished' }))
    expect(setNotifications).toHaveBeenCalledWith({ agentDone: false })
    await user.click(screen.getByRole('switch', { name: 'Sound' }))
    expect(setNotifications).toHaveBeenCalledWith({ sound: false })

    await user.click(screen.getByRole('button', { name: 'Sidebar' }))
    await user.click(screen.getByRole('switch', { name: 'Folder' }))
    expect(setSidebar).toHaveBeenCalledWith({ showPath: false })
  })

  it('shows light and dark theme pickers only when following the system, each listing its own kind', async () => {
    renderSettings()
    const user = userEvent.setup()
    expect(screen.queryByRole('combobox', { name: 'Light theme' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('switch', { name: 'Match system appearance' }))

    expect(useSettingsStore.getState().appearance.followSystem).toBe(true)
    expect(screen.queryByRole('combobox', { name: 'Ostia theme' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('combobox', { name: 'Light theme' }))
    expect(await screen.findByRole('option', { name: 'Ostia Light' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Dracula' })).not.toBeInTheDocument()
    await user.keyboard('{Escape}')

    await user.click(screen.getByRole('combobox', { name: 'Dark theme' }))
    await user.click(await screen.findByRole('option', { name: 'Dracula' }))
    expect(useSettingsStore.getState().appearance.darkTheme).toBe('dracula')
  })

  it('sets the accent from a preset or a valid hex, ignores an invalid one and resets it', async () => {
    renderSettings()
    const user = userEvent.setup()
    const hex = screen.getByRole('textbox', { name: 'Custom accent hex' })

    await user.click(screen.getByRole('button', { name: 'Accent #ee5396' }))
    expect(useSettingsStore.getState().appearance.accent).toBe('#ee5396')
    expect(hex).toHaveValue('#ee5396')

    await user.clear(hex)
    await user.type(hex, '#12')
    expect(hex).toHaveAttribute('aria-invalid', 'true')
    expect(useSettingsStore.getState().appearance.accent).toBe('#ee5396')

    await user.type(hex, '3456')
    expect(hex).toHaveAttribute('aria-invalid', 'false')
    expect(useSettingsStore.getState().appearance.accent).toBe('#123456')

    await user.click(screen.getByRole('button', { name: 'Use theme color' }))
    expect(useSettingsStore.getState().appearance.accent).toBe('')
  })

  it('shows a custom accent in the color picker swatch and no preset as selected', () => {
    useSettingsStore.setState((s) => ({ appearance: { ...s.appearance, accent: '#123456' } }))
    renderSettings()

    const picker = screen.getByLabelText('Pick a custom accent color')
    expect(picker).toHaveValue('#123456')
    const swatch = screen.getByTestId('accent-custom')
    expect(swatch).toHaveAttribute('data-selected', 'true')
    expect(swatch).toHaveStyle({ background: '#123456' })
    for (const button of screen.getAllByRole('button', { name: /^Accent #/ })) {
      expect(button).toHaveAttribute('aria-pressed', 'false')
    }
  })

  it('leaves the color picker swatch unfilled when the accent is a preset', () => {
    useSettingsStore.setState((s) => ({ appearance: { ...s.appearance, accent: '#f2b347' } }))
    renderSettings()

    expect(screen.getByRole('button', { name: 'Accent #f2b347' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    const swatch = screen.getByTestId('accent-custom')
    expect(swatch).not.toHaveAttribute('data-selected')
    expect(swatch.style.background).toBe('')
  })

  it('applies a color picked in the custom picker as the accent', () => {
    renderSettings()

    fireEvent.change(screen.getByLabelText('Pick a custom accent color'), {
      target: { value: '#aa33cc' },
    })

    expect(useSettingsStore.getState().appearance.accent).toBe('#aa33cc')
    expect(screen.getByTestId('accent-custom')).toHaveAttribute('data-selected', 'true')
  })

  it('links the terminal colors to the ostia theme until the match switch is turned off', async () => {
    useSettingsStore.setState((s) => ({ appearance: { ...s.appearance, theme: 'dracula' } }))
    renderSettings()
    const user = userEvent.setup()
    const match = screen.getByRole('switch', { name: 'Terminal colors: Match Ostia theme' })

    expect(match).toBeChecked()
    expect(screen.getAllByText(/Follows the Ostia theme/)).toHaveLength(2)
    expect(screen.getByTestId('terminal-scheme')).toHaveTextContent('Dracula')
    expect(screen.queryByRole('combobox', { name: 'Terminal colors' })).not.toBeInTheDocument()

    await user.click(match)

    expect(useSettingsStore.getState().terminal.theme).toBe('dracula')
    const picker = screen.getByRole('combobox', { name: 'Terminal colors' })
    await user.click(picker)
    await user.click(await screen.findByRole('option', { name: /Catppuccin Mocha/ }))

    expect(useSettingsStore.getState().terminal.theme).toBe('catppuccin-mocha')
    expect(useSettingsStore.getState().editor.theme).toBe('match')

    await user.click(screen.getByRole('switch', { name: 'Terminal colors: Match Ostia theme' }))
    expect(useSettingsStore.getState().terminal.theme).toBe('match')
  })

  it('previews the resolved terminal and editor schemes with their own backgrounds', () => {
    useSettingsStore.setState((s) => ({
      terminal: { ...s.terminal, theme: 'gruvbox-light' },
      editor: { ...s.editor, theme: 'nord' },
    }))
    renderSettings()

    const preview = screen.getByTestId('theme-preview')
    expect(preview).toHaveAccessibleName(
      'Preview: Adeberry Ostia theme, Gruvbox Light terminal, Nord editor',
    )
    expect(preview.querySelector('[data-preview="terminal"] > div:last-child')).toHaveStyle({
      background: '#fbf1c7',
    })
    expect(preview.querySelector('[data-preview="editor"] > div:last-child')).toHaveStyle({
      background: '#2e3440',
    })
  })

  it('commits the interface zoom on blur, clamped to 80-150', async () => {
    renderSettings()
    const user = userEvent.setup()
    const zoom = screen.getByRole('spinbutton', { name: 'Interface zoom' })

    await user.clear(zoom)
    await user.type(zoom, '400')
    await user.tab()

    expect(useSettingsStore.getState().appearance.zoom).toBe(150)
    expect(zoom).toHaveValue(150)
  })

  it('edits the notification command from the Notifications page', async () => {
    renderSettings()
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'Notifications' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Run a command on notification' }), {
      target: { value: 'say {title}' },
    })

    expect(useSettingsStore.getState().notifications.command).toBe('say {title}')
  })

  it('exposes accessible names on its controls (a11y)', async () => {
    renderSettings()
    const user = userEvent.setup()

    expect(screen.getByRole('combobox', { name: 'Ostia theme' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'UI font, Family' })).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: 'UI font, Size' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Files' }))
    expect(screen.getByRole('switch', { name: 'Show hidden files' })).toBeInTheDocument()
  })
  it('keeps only the extension switch in Extensions and links an assist extension to Settings → Assistant', async () => {
    useExtensionsStore.setState({
      list: [
        {
          id: 'assistant',
          name: 'Assistant',
          version: '1.0.0',
          description: '',
          builtin: true,
          enabled: true,
          status: 'running',
          requested: ['assist'],
          granted: ['assist'],
          unapproved: [],
          commands: [],
          panel: null,
          paneChips: [],
          workspaceChips: [],
          settings: [{ key: 'baseUrl', type: 'string', default: '', description: 'Address' }],
          settingValues: {},
          assist: ['chat'],
          secrets: [],
          secretsSet: [],
          settingsPage: null,
          category: 'other',
          languages: [],
          languageServers: [],
          agentSkills: [],
          agentHooks: [],
          iconThemes: [],
          keymaps: [],
        },
      ],
    })
    renderSettings()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Extensions' }))
    expect(screen.getByRole('switch', { name: 'Enable Assistant' })).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Base url' })).toBeNull()
    expect(screen.queryByText('MCP servers')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Configure in Assistant settings' }))
    expect(await screen.findByRole('heading', { level: 2, name: 'Assistant' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Base url' })).toBeInTheDocument()
    expect(screen.getByText('MCP servers')).toBeInTheDocument()
  })

  it('lets the settings content area be selected while buttons stay unselectable', () => {
    renderSettings()
    const content = document.querySelector('[data-slot="settings-content"]')
    expect(content).not.toBeNull()
    expect(content).toHaveClass('select-text')
    expect(content).toHaveClass('[&_[data-slot=kbd]]:select-text')
    expect(content).toHaveClass('[&_[data-slot=label]]:select-text')
    const nav = screen.getAllByRole('navigation')[0]
    expect(nav.contains(content)).toBe(false)
  })
})
