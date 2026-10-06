import '@testing-library/jest-dom/vitest'
import type { ExtensionInfo } from '@shared/extensions'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { registerBuiltinCommands } from '../commands/builtins'
import { commands } from '../commands/registry'
import { zhHant } from '../i18n/dict'
import { languagesFrom } from '../lib/languagePacks'
import { useExtensionsStore } from '../stores/extensionsStore'
import { startKeymapSync, useKeymapStore } from '../stores/keymapStore'
import { usePluginsStore } from '../stores/pluginsStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { CommandPalette } from './CommandPalette'
import { ChordRecorder, KeyboardSection } from './KeyboardSection'

const initialSettings = useSettingsStore.getState()
const initialPlugins = usePluginsStore.getState()
const initialExtensions = useExtensionsStore.getState()
const initialKeymap = useKeymapStore.getState()

const keymapExtension: ExtensionInfo = {
  id: 'keys',
  name: 'Keys',
  version: '1.0.0',
  description: '',
  category: 'other',
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
  settingsPage: null,
  assist: [],
  secrets: [],
  secretsSet: [],
  iconThemes: [],
  languages: [],
  keymaps: [
    { id: 'alt', label: 'Alt keys' },
    { id: 'mac', label: 'Mac only', platform: 'darwin' },
  ],
  languageServers: [],
  agentSkills: [],
  agentHooks: [],
}

const press = (key: string, init: KeyboardEventInit = {}): void => {
  act(() => {
    fireEvent.keyDown(window, { key, ...init })
  })
}

const row = (name: RegExp): HTMLElement => {
  const cell = screen.getAllByRole('cell').find((c) => name.test(c.textContent ?? ''))
  const tr = cell?.closest('tr')
  if (!tr) throw new Error(`no row for ${name}`)
  return tr
}

const record = async (command: string): Promise<void> => {
  await userEvent.click(screen.getByRole('button', { name: `Record a shortcut for ${command}` }))
}

describe('ChordRecorder', () => {
  afterEach(cleanup)

  it('reports the first non-modifier key with its modifiers', () => {
    const onRecord = vi.fn()
    const onCancel = vi.fn()
    render(<ChordRecorder label="rec" onRecord={onRecord} onCancel={onCancel} />)
    press('Control', { ctrlKey: true })
    expect(onRecord).not.toHaveBeenCalled()
    press('K', { ctrlKey: true, shiftKey: true, code: 'KeyK' })
    expect(onRecord).toHaveBeenCalledWith({
      ctrl: true,
      shift: true,
      alt: false,
      meta: false,
      key: 'k',
    })
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('cancels on a bare Escape and keeps the key from reaching other window listeners', () => {
    const onRecord = vi.fn()
    const onCancel = vi.fn()
    const behind = vi.fn()
    window.addEventListener('keydown', behind)
    try {
      render(<ChordRecorder label="rec" onRecord={onRecord} onCancel={onCancel} />)
      press('Escape')
      expect(onCancel).toHaveBeenCalledTimes(1)
      expect(onRecord).not.toHaveBeenCalled()
      expect(behind).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', behind)
    }
  })
})

describe('KeyboardSection', () => {
  beforeAll(() => {
    if (!commands.has('palette.toggle')) registerBuiltinCommands()
  })

  afterEach(() => {
    cleanup()
    useSettingsStore.setState(initialSettings, true)
    usePluginsStore.setState(initialPlugins, true)
    useExtensionsStore.setState(initialExtensions, true)
    useKeymapStore.setState(initialKeymap, true)
    useUIStore.setState({ paletteOpen: false })
  })

  it('marks the chords that act only in a terminal', () => {
    render(<KeyboardSection />)
    const clear = within(row(/Clear Terminal/))
    expect(clear.getByText('Ctrl+Shift+K')).toBeInTheDocument()
    expect(clear.getByText('in a terminal')).toBeInTheDocument()
    const zoom = within(row(/Zoom Pane/))
    expect(zoom.getByText('Ctrl+Shift+Enter')).toBeInTheDocument()
    expect(zoom.getByText('Ctrl+Shift+X')).toBeInTheDocument()
    expect(zoom.getAllByText('in a terminal')).toHaveLength(1)
    expect(within(row(/Command Palette/)).queryByText('in a terminal')).toBeNull()
  })

  it('picks a keymap, lists the entries it skipped, and puts the user’s chords on top of it', async () => {
    useExtensionsStore.setState({ list: [keymapExtension] })
    vi.mocked(window.ostia.keymaps.load).mockResolvedValue({
      ok: true,
      keymap: {
        extId: 'keys',
        id: 'alt',
        label: 'Alt keys',
        bindings: { 'palette.toggle': 'Ctrl+Alt+P', 'view.toggleRail': null },
        skipped: [{ command: 'pane.zoom', value: 'Ctrl+X', problem: 'ctrl-key' }],
      },
    })
    const stop = startKeymapSync()
    try {
      render(<KeyboardSection />)
      const picker = screen.getByRole('combobox', { name: 'App shortcuts' })
      expect(picker).toHaveTextContent('Ostia')
      expect(within(row(/Command Palette/)).getByText('Ctrl+Shift+P')).toBeInTheDocument()

      await userEvent.click(picker)
      expect(screen.queryByRole('option', { name: 'Mac only' })).toBeNull()
      await userEvent.click(await screen.findByRole('option', { name: 'Alt keys' }))
      expect(useSettingsStore.getState().keymap).toBe('keys/alt')
      expect(await within(row(/Command Palette/)).findByText('Ctrl+Alt+P')).toBeInTheDocument()
      expect(within(row(/Toggle Sidebar/)).getByText('Unassigned')).toBeInTheDocument()
      expect(window.ostia.keymaps.load).toHaveBeenCalledWith('keys/alt')
      expect(
        screen.getByText(
          'pane.zoom “Ctrl+X”: plain Ctrl keys belong to the shell. Add Shift or Alt.',
        ),
      ).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Reset Command Palette' })).toBeDisabled()

      await record('Command Palette')
      press('Y', { ctrlKey: true, shiftKey: true, code: 'KeyY' })
      expect(within(row(/Command Palette/)).getByText('Ctrl+Shift+Y')).toBeInTheDocument()
      await userEvent.click(screen.getByRole('button', { name: 'Reset Command Palette' }))
      expect(useSettingsStore.getState().keybindings).toEqual({})
      expect(within(row(/Command Palette/)).getByText('Ctrl+Alt+P')).toBeInTheDocument()

      await record('Command Palette')
      press('P', { ctrlKey: true, altKey: true, code: 'KeyP' })
      expect(useSettingsStore.getState().keybindings).toEqual({})

      await userEvent.click(screen.getByRole('combobox', { name: 'App shortcuts' }))
      await userEvent.click(await screen.findByRole('option', { name: 'Ostia' }))
      expect(useSettingsStore.getState().keymap).toBe('ostia')
      expect(within(row(/Command Palette/)).getByText('Ctrl+Shift+P')).toBeInTheDocument()
      expect(screen.queryByText(/pane\.zoom “Ctrl\+X”/)).toBeNull()
    } finally {
      stop()
    }
  })

  it('shows the default preset and table for a keymap no enabled extension offers here', () => {
    useExtensionsStore.setState({ list: [{ ...keymapExtension, enabled: false }] })
    useSettingsStore.setState({ keymap: 'keys/alt' })
    const stop = startKeymapSync()
    try {
      render(<KeyboardSection />)
      expect(screen.getByRole('combobox', { name: 'App shortcuts' })).toHaveTextContent('Ostia')
      expect(within(row(/Command Palette/)).getByText('Ctrl+Shift+P')).toBeInTheDocument()
      expect(window.ostia.keymaps.load).not.toHaveBeenCalled()
    } finally {
      stop()
    }
  })

  it('says when the chosen keymap cannot be loaded', async () => {
    useExtensionsStore.setState({ list: [keymapExtension] })
    useSettingsStore.setState({ keymap: 'keys/alt' })
    vi.mocked(window.ostia.keymaps.load).mockResolvedValue({
      ok: false,
      error: 'keys.json: missing',
    })
    const stop = startKeymapSync()
    try {
      render(<KeyboardSection />)
      expect(
        await screen.findByText(
          'The keymap “Alt keys” couldn’t be loaded (keys.json: missing), so the default shortcuts apply.',
        ),
      ).toBeInTheDocument()
      expect(within(row(/Command Palette/)).getByText('Ctrl+Shift+P')).toBeInTheDocument()
    } finally {
      stop()
    }
  })

  it('names the keymap picker in Traditional Chinese', () => {
    usePluginsStore.setState({
      languages: languagesFrom([
        { extId: 'langpack-zh-hant', id: 'zh-Hant', label: '繁體中文', catalog: zhHant },
      ]),
    })
    useSettingsStore.setState({ locale: 'zh-Hant' })
    render(<KeyboardSection />)
    expect(screen.getByRole('combobox', { name: 'App 鍵位' })).toHaveTextContent('Ostia')
  })

  it('lists commands with their current shortcut, including palette commands without one', () => {
    render(<KeyboardSection />)
    expect(within(row(/Command Palette/)).getByText('Ctrl+Shift+P')).toBeInTheDocument()
    expect(within(row(/Split Pane Right/)).getByText('Ctrl+Alt+\\')).toBeInTheDocument()
    expect(within(row(/New Terminal Tab/)).getByText('Ctrl+Shift+T')).toBeInTheDocument()
    expect(within(row(/New Browser Tab/)).getByText('Unassigned')).toBeInTheDocument()
    expect(within(row(/Copy \(terminal\)/)).getByText('Ctrl+Shift+C')).toBeInTheDocument()
  })

  it('names a default shortcut whose command is not registered yet by its title, not its id', () => {
    expect(commands.has('assist.compose')).toBe(false)
    render(<KeyboardSection />)
    const compose = row(/assist\.compose/)
    expect(within(compose).getByText('Compose with Assistant')).toBeVisible()
  })

  it('filters rows by title, id or shortcut', async () => {
    render(<KeyboardSection />)
    await userEvent.type(screen.getByRole('textbox', { name: 'Search shortcuts' }), 'ctrl+shift+b')
    expect(screen.getByText('Toggle Sidebar')).toBeInTheDocument()
    expect(screen.queryByText('Command Palette')).toBeNull()
  })

  it('records a new chord and saves it', async () => {
    render(<KeyboardSection />)
    await record('Command Palette')
    expect(within(row(/Command Palette/)).getByText(/Press a shortcut/)).toBeInTheDocument()
    press('Y', { ctrlKey: true, shiftKey: true, code: 'KeyY' })
    expect(useSettingsStore.getState().keybindings['palette.toggle']).toBe('Ctrl+Shift+Y')
    expect(within(row(/Command Palette/)).getByText('Ctrl+Shift+Y')).toBeInTheDocument()
  })

  it('refuses a plain Ctrl+R with an inline error and keeps recording', async () => {
    render(<KeyboardSection />)
    await record('Command Palette')
    press('r', { ctrlKey: true, code: 'KeyR' })
    expect(within(row(/Command Palette/)).getByRole('alert')).toHaveTextContent(
      /Ctrl\+R can’t be used: plain Ctrl keys belong to the shell/,
    )
    expect(useSettingsStore.getState().keybindings).toEqual({})
    press('Y', { ctrlKey: true, shiftKey: true, code: 'KeyY' })
    expect(useSettingsStore.getState().keybindings['palette.toggle']).toBe('Ctrl+Shift+Y')
    expect(within(row(/Command Palette/)).queryByRole('alert')).toBeNull()
  })

  it('refuses bare keys, Tab and plain arrows', async () => {
    render(<KeyboardSection />)
    await record('Command Palette')
    press('k', { code: 'KeyK' })
    expect(screen.getByRole('alert')).toHaveTextContent(/single keys belong to the shell/)
    press('Tab', { shiftKey: true, code: 'Tab' })
    expect(screen.getByRole('alert')).toHaveTextContent(/Tab belongs to the shell/)
    press('Tab', { ctrlKey: true, altKey: true, code: 'Tab' })
    expect(screen.getByRole('alert')).toHaveTextContent(/Only Ctrl\+Tab and Ctrl\+Shift\+Tab/)
    press('ArrowUp', { ctrlKey: true, code: 'ArrowUp' })
    expect(screen.getByRole('alert')).toHaveTextContent(/arrows belong to the shell/)
    expect(useSettingsStore.getState().keybindings).toEqual({})
  })

  it('cancels recording on Escape without changing the binding', async () => {
    render(<KeyboardSection />)
    await record('Command Palette')
    press('Escape')
    expect(within(row(/Command Palette/)).getByText('Ctrl+Shift+P')).toBeInTheDocument()
    expect(useSettingsStore.getState().keybindings).toEqual({})
  })

  it('warns about a chord another command uses and replaces it on confirm', async () => {
    render(<KeyboardSection />)
    await record('Toggle Sidebar')
    press('P', { ctrlKey: true, shiftKey: true, code: 'KeyP' })
    expect(
      screen.getByText(/Ctrl\+Shift\+P is already the shortcut for Command Palette/),
    ).toBeInTheDocument()
    expect(useSettingsStore.getState().keybindings).toEqual({})
    await userEvent.click(screen.getByRole('button', { name: 'Replace' }))
    expect(useSettingsStore.getState().keybindings).toEqual({
      'palette.toggle': null,
      'view.toggleRail': 'Ctrl+Shift+P',
    })
    expect(within(row(/Command Palette/)).getByText('Unassigned')).toBeInTheDocument()
  })

  it('shows every chord of a command, and taking one leaves the others', async () => {
    useSettingsStore.setState({ keybindings: { 'palette.toggle': ['Ctrl+Shift+Y', 'Ctrl+Alt+P'] } })
    render(<KeyboardSection />)
    const palette = within(row(/Command Palette/))
    expect(palette.getByText('Ctrl+Shift+Y')).toBeInTheDocument()
    expect(palette.getByText('Ctrl+Alt+P')).toBeInTheDocument()
    await record('Toggle Sidebar')
    press('P', { ctrlKey: true, altKey: true, code: 'KeyP' })
    await userEvent.click(screen.getByRole('button', { name: 'Replace' }))
    expect(useSettingsStore.getState().keybindings).toEqual({
      'palette.toggle': 'Ctrl+Shift+Y',
      'view.toggleRail': 'Ctrl+Alt+P',
    })
    await record('Command Palette')
    press('U', { ctrlKey: true, altKey: true, code: 'KeyU' })
    expect(useSettingsStore.getState().keybindings['palette.toggle']).toBe('Ctrl+Alt+U')
  })

  it('names the chord of a list this computer ignores', () => {
    useSettingsStore.setState({ keybindings: { 'palette.toggle': ['Ctrl+Shift+Y', 'Ctrl+R'] } })
    render(<KeyboardSection />)
    expect(within(row(/Command Palette/)).getByText('Ctrl+Shift+Y')).toBeInTheDocument()
    expect(
      within(row(/Command Palette/)).getByText(/“Ctrl\+R” is ignored on this computer/),
    ).toBeInTheDocument()
  })

  it('warns about a Monaco default and saves only when confirmed', async () => {
    render(<KeyboardSection />)
    await record('Command Palette')
    press('K', { ctrlKey: true, shiftKey: true, code: 'KeyK' })
    expect(screen.getByText(/The code editor also uses Ctrl\+Shift\+K/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(useSettingsStore.getState().keybindings).toEqual({})
    await record('Command Palette')
    press('K', { ctrlKey: true, shiftKey: true, code: 'KeyK' })
    await userEvent.click(screen.getByRole('button', { name: 'Use anyway' }))
    expect(useSettingsStore.getState().keybindings['palette.toggle']).toBe('Ctrl+Shift+K')
  })

  it('records any digit as the 1-9 range for the workspace jump', async () => {
    render(<KeyboardSection />)
    await record('Go to Workspace')
    press('#', { ctrlKey: true, altKey: true, code: 'Digit3' })
    expect(useSettingsStore.getState().keybindings['workspace.goto']).toBe('Ctrl+Alt+1-9')
  })

  it('resets one row and then all rows', async () => {
    useSettingsStore.setState({
      keybindings: { 'palette.toggle': 'Ctrl+Shift+Y', find: 'Ctrl+Alt+F' },
    })
    render(<KeyboardSection />)
    expect(screen.getByRole('button', { name: 'Reset Toggle Sidebar' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Reset Command Palette' }))
    expect(useSettingsStore.getState().keybindings).toEqual({ find: 'Ctrl+Alt+F' })
    expect(within(row(/Command Palette/)).getByText('Ctrl+Shift+P')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Reset all' }))
    expect(useSettingsStore.getState().keybindings).toEqual({})
    expect(screen.getByRole('button', { name: 'Reset all' })).toBeDisabled()
  })

  it('explains a stored chord this computer ignores', () => {
    useSettingsStore.setState({ keybindings: { 'palette.toggle': 'Ctrl+R' } })
    render(<KeyboardSection />)
    expect(within(row(/Command Palette/)).getByText('Ctrl+Shift+P')).toBeInTheDocument()
    expect(
      within(row(/Command Palette/)).getByText(/“Ctrl\+R” is ignored on this computer/),
    ).toBeInTheDocument()
  })

  it('shows the rebound chord in the command palette', async () => {
    useSettingsStore.setState({ keybindings: { 'view.toggleRail': 'Ctrl+Alt+B' } })
    useUIStore.setState({ paletteOpen: true })
    render(<CommandPalette />)
    const option = await screen.findByRole('option', { name: /Toggle Sidebar/ })
    expect(within(option).getByText('Ctrl+Alt+B')).toBeInTheDocument()
  })
  it('lists core commands in the human’s language and still finds them by their English title', async () => {
    usePluginsStore.setState({
      languages: languagesFrom([
        { extId: 'langpack-zh-hant', id: 'zh-Hant', label: '繁體中文', catalog: zhHant },
      ]),
    })
    useSettingsStore.setState({ locale: 'zh-Hant' })
    render(<KeyboardSection />)
    expect(within(row(/指令面板/)).getByText('Ctrl+Shift+P')).toBeInTheDocument()
    expect(within(row(/assist\.compose/)).getByText('使用助理撰寫')).toBeVisible()

    await userEvent.type(screen.getByRole('textbox', { name: '搜尋快捷鍵' }), 'toggle sidebar')

    expect(row(/切換側邊欄/)).toBeInTheDocument()
    expect(screen.getAllByRole('row')).toHaveLength(2)
  })

  it('offers Ostia standard and No translation for text editing on Linux, Ostia standard first', async () => {
    render(<KeyboardSection />)
    const picker = screen.getByRole('combobox', { name: 'Text editing' })
    expect(picker).toHaveTextContent('Ostia standard')
    const buttons = screen.getAllByRole('button', { name: /^Edit / })
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Edit Ctrl+←',
      'Edit Ctrl+→',
      'Edit Alt+←',
      'Edit Alt+→',
      'Edit Ctrl+Backspace',
    ])
    await userEvent.click(picker)
    expect(await screen.findByRole('option', { name: 'Ostia standard' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /Natural Text Editing/ })).toBeNull()
    await userEvent.click(screen.getByRole('option', { name: 'No translation' }))
    expect(useSettingsStore.getState().terminalKeymap).toBe('none')
    expect(screen.queryAllByRole('button', { name: /^Edit / })).toEqual([])
  })

  it('adds a key that sends text to the terminal, refusing keys that type, and removes it', async () => {
    render(<KeyboardSection />)
    await userEvent.click(screen.getByRole('button', { name: 'Add a terminal key' }))
    press('k', { code: 'KeyK' })
    expect(screen.getByRole('alert')).toHaveTextContent(/K can’t be used: single keys/)
    press('K', { ctrlKey: true, altKey: true, code: 'KeyK' })
    await userEvent.type(screen.getByRole('textbox', { name: 'What to send' }), 'clear\\r')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(useSettingsStore.getState().terminalKeys).toEqual({
      'Ctrl+Alt+K': { type: 'text', value: 'clear\\r' },
    })
    expect(within(row(/clear/)).getByText('Ctrl+Alt+K')).toBeInTheDocument()
    expect(within(row(/clear/)).getByText('Custom')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Remove Ctrl+Alt+K' }))
    expect(useSettingsStore.getState().terminalKeys).toEqual({})
    expect(screen.queryByText('clear\\r')).toBeNull()
  })

  it('says what is wrong with a value it cannot send and keeps the editor open', async () => {
    render(<KeyboardSection />)
    await userEvent.click(screen.getByRole('button', { name: 'Add a terminal key' }))
    press('K', { ctrlKey: true, altKey: true, code: 'KeyK' })
    await userEvent.click(screen.getByRole('combobox', { name: 'Send' }))
    await userEvent.click(await screen.findByRole('option', { name: 'Hex codes' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'What to send' }), '0x80')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByRole('alert')).toHaveTextContent(/bytes from 0x00 to 0x7F/)
    expect(useSettingsStore.getState().terminalKeys).toEqual({})
    await userEvent.clear(screen.getByRole('textbox', { name: 'What to send' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'What to send' }), '0x1b 0x7f')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(useSettingsStore.getState().terminalKeys).toEqual({
      'Ctrl+Alt+K': { type: 'hex', value: '0x1b 0x7f' },
    })
  })

  it('asks before giving a terminal key a command’s chord, and unbinds the command on Replace', async () => {
    render(<KeyboardSection />)
    await userEvent.click(screen.getByRole('button', { name: 'Add a terminal key' }))
    press('P', { ctrlKey: true, shiftKey: true, code: 'KeyP' })
    await userEvent.type(screen.getByRole('textbox', { name: 'What to send' }), 'x')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(
      screen.getByText(/Ctrl\+Shift\+P is already the shortcut for Command Palette/),
    ).toBeInTheDocument()
    expect(useSettingsStore.getState().terminalKeys).toEqual({})
    await userEvent.click(screen.getByRole('button', { name: 'Replace' }))
    expect(useSettingsStore.getState().keybindings).toEqual({ 'palette.toggle': null })
    expect(useSettingsStore.getState().terminalKeys).toEqual({
      'Ctrl+Shift+P': { type: 'text', value: 'x' },
    })
    expect(within(row(/Command Palette/)).getByText('Unassigned')).toBeInTheDocument()
  })

  it('asks before giving a command a terminal key’s chord, and removes the key on Replace', async () => {
    useSettingsStore.setState({ terminalKeys: { 'Ctrl+Alt+K': { type: 'escape', value: 'k' } } })
    render(<KeyboardSection />)
    await record('Command Palette')
    press('K', { ctrlKey: true, altKey: true, code: 'KeyK' })
    expect(
      screen.getByText('Ctrl+Alt+K sends ESC k to the terminal. Replacing removes it there.'),
    ).toBeInTheDocument()
    expect(useSettingsStore.getState().keybindings).toEqual({})
    await userEvent.click(screen.getByRole('button', { name: 'Replace' }))
    expect(useSettingsStore.getState().keybindings['palette.toggle']).toBe('Ctrl+Alt+K')
    expect(useSettingsStore.getState().terminalKeys).toEqual({})
  })

  it('edits a terminal key, finds it by what it sends, and Reset all clears terminal keys too', async () => {
    useSettingsStore.setState({ terminalKeys: { 'Ctrl+Alt+K': { type: 'escape', value: 'k' } } })
    render(<KeyboardSection />)
    await userEvent.type(screen.getByRole('textbox', { name: 'Search shortcuts' }), 'esc k')
    expect(screen.getAllByRole('row')).toHaveLength(2)
    await userEvent.click(screen.getByRole('button', { name: 'Edit Ctrl+Alt+K' }))
    const value = screen.getByRole('textbox', { name: 'What to send' })
    expect(value).toHaveValue('k')
    await userEvent.clear(value)
    await userEvent.type(value, 'j')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(useSettingsStore.getState().terminalKeys).toEqual({
      'Ctrl+Alt+K': { type: 'escape', value: 'j' },
    })
    await userEvent.click(screen.getByRole('button', { name: 'Reset all' }))
    expect(useSettingsStore.getState().terminalKeys).toEqual({})
    expect(screen.getByRole('button', { name: 'Reset all' })).toBeDisabled()
  })
})
