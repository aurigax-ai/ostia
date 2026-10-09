import '@testing-library/jest-dom/vitest'
import { registerBuiltinCommands } from '@/commands/builtins'
import { commands } from '@/commands/registry'
import { CommandPalette } from '@/components/CommandPalette'
import { loadDesktops } from '@/lib/app/desktop'
import { languagesFrom } from '@/lib/extensions/languagePacks'
import { installDoubleShift } from '@/lib/keys/chords'
import { startKeymapSync, useKeymapStore } from '@/stores/app/keymapStore'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useUIStore } from '@/stores/app/uiStore'
import { useExtensionsStore } from '@/stores/extensions/extensionsStore'
import { usePluginsStore } from '@/stores/extensions/pluginsStore'
import { zhHant } from '@shared/app/dict'
import type { ExtensionInfo } from '@shared/extensions'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
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

const tapShift = (): void => {
  act(() => {
    fireEvent.keyDown(window, { key: 'Shift', shiftKey: true, code: 'ShiftLeft' })
    fireEvent.keyUp(window, { key: 'Shift', code: 'ShiftLeft' })
  })
}

const rowWhere = (matches: (text: string) => boolean, name: string): HTMLElement => {
  const cell = [...document.querySelectorAll('td')].find((c) => matches(c.textContent ?? ''))
  const tr = cell?.closest('tr')
  if (!tr) throw new Error(`no row for ${name}`)
  return tr
}

const row = (name: RegExp): HTMLElement => rowWhere((text) => name.test(text), String(name))

const change = async (keys: string, command: string): Promise<void> => {
  await userEvent.click(
    screen.getByLabelText(`Change ${keys} for ${command}`, { selector: 'button' }),
  )
}

const add = async (command: string): Promise<void> => {
  await userEvent.click(
    screen.getByLabelText(`Add a shortcut for ${command}`, { selector: 'button' }),
  )
}

const groupNames = (): string[] =>
  screen
    .getAllByRole('columnheader')
    .filter((h) => h.getAttribute('scope') === 'colgroup')
    .map((h) => h.textContent ?? '')

const presets = (layer: string): HTMLElement => screen.getByRole('group', { name: layer })

const applied = (layer: string): string =>
  within(presets(layer))
    .getAllByRole('button')
    .filter((b) => b.getAttribute('aria-pressed') === 'true')
    .map((b) => b.textContent ?? '')
    .join()

const pickPreset = async (layer: string, name: string): Promise<void> => {
  await userEvent.click(within(presets(layer)).getByRole('button', { name }))
}

const applyPreset = async (layer: string, name: string): Promise<void> => {
  await pickPreset(layer, name)
  await userEvent.click(await screen.findByRole('button', { name: `Apply ${name}` }))
}

const pickAction = async (name: string): Promise<void> => {
  await userEvent.click(screen.getByRole('combobox', { name: 'Action' }))
  await userEvent.click(await screen.findByRole('option', { name }))
}

const columnWidths = (): string[] =>
  [...screen.getByRole('table').querySelectorAll('col')].map((c) => c.className)

let stopSync: (() => void) | null = null

const syncKeymaps = (): void => {
  stopSync = startKeymapSync()
}

const stopKeymapSync = (): void => {
  stopSync?.()
  stopSync = null
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

describe('ChordRecorder and Shift twice', () => {
  afterEach(cleanup)

  it('records two lone Shift taps and keeps them from opening anything meanwhile', () => {
    const onRecord = vi.fn()
    const searched = vi.fn()
    commands.register({ id: 'palette.searchEverywhere', title: 'Search', run: searched })
    const uninstall = installDoubleShift(window, false)
    try {
      render(<ChordRecorder label="rec" onRecord={onRecord} onCancel={vi.fn()} />)
      tapShift()
      expect(onRecord).not.toHaveBeenCalled()
      tapShift()
      expect(onRecord).toHaveBeenCalledWith({
        ctrl: false,
        shift: true,
        alt: false,
        meta: false,
        key: 'shift',
      })
      expect(searched).not.toHaveBeenCalled()
      cleanup()
      tapShift()
      tapShift()
      expect(searched).toHaveBeenCalledTimes(1)
    } finally {
      uninstall()
      commands.unregister('palette.searchEverywhere')
    }
  })
})

describe('KeyboardSection', () => {
  beforeAll(() => {
    if (!commands.has('palette.toggle')) registerBuiltinCommands()
  })

  afterEach(() => {
    stopKeymapSync()
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

  it('picks a keymap, lists the entries it skipped, and goes back to Ostia', async () => {
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
    syncKeymaps()
    render(<KeyboardSection />)
    expect(applied('App shortcuts')).toBe('Ostia')
    expect(within(row(/Command Palette/)).getByText('Ctrl+Shift+P')).toBeInTheDocument()

    expect(within(presets('App shortcuts')).queryByRole('button', { name: 'Mac only' })).toBeNull()
    await applyPreset('App shortcuts', 'Alt keys')
    expect(useSettingsStore.getState().keymap).toBe('keys/alt')
    expect(await within(row(/Command Palette/)).findByText('Ctrl+Alt+P')).toBeInTheDocument()
    expect(within(row(/Toggle Sidebar/)).getByText('Unassigned')).toBeInTheDocument()
    expect(window.ostia.keymaps.load).toHaveBeenCalledWith('keys/alt')
    expect(
      screen.getByText(
        'pane.zoom “Ctrl+X”: plain Ctrl keys belong to the shell. Add Shift or Alt.',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reset Command Palette' })).toBeNull()
    expect(within(row(/Command Palette/)).getByText('Alt keys')).toBeInTheDocument()
    expect(within(row(/Toggle Sidebar/)).getByText('Alt keys')).toBeInTheDocument()
    expect(within(row(/Toggle Sidebar/)).getByText('removes Ctrl+Shift+B')).toBeInTheDocument()
    expect(within(row(/New Terminal Tab/)).queryByText('Alt keys')).toBeNull()

    await applyPreset('App shortcuts', 'Ostia')
    expect(useSettingsStore.getState().keymap).toBe('ostia')
    expect(within(row(/Command Palette/)).getByText('Ctrl+Shift+P')).toBeInTheDocument()
    expect(screen.queryByText(/pane\.zoom “Ctrl\+X”/)).toBeNull()
  })

  it('puts the user’s chords on top of a chosen keymap', async () => {
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
    useSettingsStore.setState({ keymap: 'keys/alt' })
    syncKeymaps()
    render(<KeyboardSection />)
    expect(await within(row(/Command Palette/)).findByText('Ctrl+Alt+P')).toBeInTheDocument()

    await change('Ctrl+Alt+P', 'Command Palette')
    press('Y', { ctrlKey: true, shiftKey: true, code: 'KeyY' })
    expect(within(row(/Command Palette/)).getByText('Ctrl+Shift+Y')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Reset Command Palette' }))
    expect(useSettingsStore.getState().keybindings).toEqual({})
    expect(within(row(/Command Palette/)).getByText('Ctrl+Alt+P')).toBeInTheDocument()

    await change('Ctrl+Alt+P', 'Command Palette')
    press('P', { ctrlKey: true, altKey: true, code: 'KeyP' })
    expect(useSettingsStore.getState().keybindings).toEqual({})
  })

  it('shows the default preset and table for a keymap no enabled extension offers here', () => {
    useExtensionsStore.setState({ list: [{ ...keymapExtension, enabled: false }] })
    useSettingsStore.setState({ keymap: 'keys/alt' })
    syncKeymaps()
    render(<KeyboardSection />)
    expect(applied('App shortcuts')).toBe('Ostia')
    expect(within(row(/Command Palette/)).getByText('Ctrl+Shift+P')).toBeInTheDocument()
    expect(window.ostia.keymaps.load).not.toHaveBeenCalled()
  })

  it('says when the chosen keymap cannot be loaded', async () => {
    useExtensionsStore.setState({ list: [keymapExtension] })
    useSettingsStore.setState({ keymap: 'keys/alt' })
    vi.mocked(window.ostia.keymaps.load).mockResolvedValue({
      ok: false,
      error: 'keys.json: missing',
    })
    syncKeymaps()
    render(<KeyboardSection />)
    expect(
      await screen.findByText(
        'The keymap “Alt keys” couldn’t be loaded (keys.json: missing), so the default shortcuts apply.',
      ),
    ).toBeInTheDocument()
    expect(within(row(/Command Palette/)).getByText('Ctrl+Shift+P')).toBeInTheDocument()
  })

  it('names the keymap picker in Traditional Chinese', () => {
    usePluginsStore.setState({
      languages: languagesFrom([
        { extId: 'langpack-zh-hant', id: 'zh-Hant', label: '繁體中文', catalog: zhHant },
      ]),
    })
    useSettingsStore.setState({ locale: 'zh-Hant' })
    render(<KeyboardSection />)
    expect(applied('App 鍵位')).toBe('Ostia')
    expect(screen.getByRole('group', { name: '檢視' })).toHaveTextContent('生效中')
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
    await change('Ctrl+Shift+P', 'Command Palette')
    expect(within(row(/Command Palette/)).getByText(/Press a shortcut/)).toBeInTheDocument()
    press('Y', { ctrlKey: true, shiftKey: true, code: 'KeyY' })
    expect(useSettingsStore.getState().keybindings['palette.toggle']).toBe('Ctrl+Shift+Y')
    expect(within(row(/Command Palette/)).getByText('Ctrl+Shift+Y')).toBeInTheDocument()
  })

  it('refuses a plain Ctrl+R with an inline error and keeps recording', async () => {
    render(<KeyboardSection />)
    await change('Ctrl+Shift+P', 'Command Palette')
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
    await change('Ctrl+Shift+P', 'Command Palette')
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
    await change('Ctrl+Shift+P', 'Command Palette')
    press('Escape')
    expect(within(row(/Command Palette/)).getByText('Ctrl+Shift+P')).toBeInTheDocument()
    expect(useSettingsStore.getState().keybindings).toEqual({})
  })

  it('warns about a chord another command uses and replaces it on confirm', async () => {
    render(<KeyboardSection />)
    await change('Ctrl+Shift+B', 'Toggle Sidebar')
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
    await change('Ctrl+Shift+B', 'Toggle Sidebar')
    press('P', { ctrlKey: true, altKey: true, code: 'KeyP' })
    await userEvent.click(screen.getByRole('button', { name: 'Replace' }))
    expect(useSettingsStore.getState().keybindings).toEqual({
      'palette.toggle': 'Ctrl+Shift+Y',
      'view.toggleRail': 'Ctrl+Alt+P',
    })
    await change('Ctrl+Shift+Y', 'Command Palette')
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

  it('marks a chord the desktop takes first, and only on that desktop', async () => {
    const onDesktop = async (desktops: string[]): Promise<void> => {
      const info = await window.ostia.info()
      vi.mocked(window.ostia.info).mockResolvedValueOnce({ ...info, desktops })
      await loadDesktops()
    }
    useSettingsStore.setState({ keybindings: { 'palette.toggle': ['Ctrl+Shift+Y', 'Super+L'] } })
    await onDesktop(['ubuntu', 'GNOME'])
    render(<KeyboardSection />)
    expect(
      within(row(/Command Palette/)).getByText(
        'GNOME takes Super+L first, so it never reaches Ostia',
      ),
    ).toBeInTheDocument()
    cleanup()
    await onDesktop(['XFCE'])
    render(<KeyboardSection />)
    expect(within(row(/Command Palette/)).getByText('Super+L')).toBeInTheDocument()
    expect(screen.queryByText(/takes .* first/)).toBeNull()
    await onDesktop([])
  })

  it('warns about a Monaco default and saves only when confirmed', async () => {
    render(<KeyboardSection />)
    await change('Ctrl+Shift+P', 'Command Palette')
    press('K', { ctrlKey: true, shiftKey: true, code: 'KeyK' })
    expect(screen.getByText(/The code editor also uses Ctrl\+Shift\+K/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(useSettingsStore.getState().keybindings).toEqual({})
    await change('Ctrl+Shift+P', 'Command Palette')
    press('K', { ctrlKey: true, shiftKey: true, code: 'KeyK' })
    await userEvent.click(screen.getByRole('button', { name: 'Use anyway' }))
    expect(useSettingsStore.getState().keybindings['palette.toggle']).toBe('Ctrl+Shift+K')
  })

  it('records any digit as the 1-9 range for the workspace jump', async () => {
    render(<KeyboardSection />)
    await userEvent.click(screen.getByRole('button', { name: /^Change .+ for Go to Workspace$/ }))
    press('#', { ctrlKey: true, altKey: true, code: 'Digit3' })
    expect(useSettingsStore.getState().keybindings['workspace.goto']).toBe('Ctrl+Alt+1-9')
  })

  it('resets one row and then all rows', async () => {
    useSettingsStore.setState({
      keybindings: { 'palette.toggle': 'Ctrl+Shift+Y', find: 'Ctrl+Alt+F' },
    })
    render(<KeyboardSection />)
    expect(screen.queryByRole('button', { name: 'Reset Toggle Sidebar' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Reset Command Palette' }))
    expect(useSettingsStore.getState().keybindings).toEqual({ find: 'Ctrl+Alt+F' })
    expect(within(row(/Command Palette/)).getByText('Ctrl+Shift+P')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'My changes (1)' }))
    await userEvent.click(screen.getByRole('button', { name: 'Revert everything to Ostia' }))
    await userEvent.click(screen.getByRole('button', { name: 'Revert everything' }))
    expect(useSettingsStore.getState().keybindings).toEqual({})
    expect(screen.getByText('Nothing differs from a clean Ostia.')).toBeInTheDocument()
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
    expect(groupNames()).toEqual(['顯示'])
    expect(screen.getAllByRole('row')).toHaveLength(3)
  })

  it('offers Ostia standard and No translation for text editing on Linux, Ostia standard first', async () => {
    render(<KeyboardSection />)
    expect(applied('Text editing')).toBe('Ostia standard')
    const buttons = screen.getAllByRole('button', { name: /^Edit / })
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Edit Alt+←',
      'Edit Alt+→',
      'Edit Ctrl+Backspace',
      'Edit Ctrl+←',
      'Edit Ctrl+→',
    ])
    const choices = within(presets('Text editing'))
      .getAllByRole('button')
      .map((b) => b.textContent)
    expect(choices).toEqual(['Ostia standard', 'No translation'])
    await applyPreset('Text editing', 'No translation')
    expect(useSettingsStore.getState().terminalKeymap).toBe('none')
    expect(screen.queryAllByRole('button', { name: /^Edit / })).toEqual([])
  })

  it('flags no default Linux terminal key, though browser back and forward share Alt+arrows', () => {
    render(<KeyboardSection />)
    expect(screen.getByRole('button', { name: 'Edit Alt+←' })).toBeInTheDocument()
    expect(screen.queryByText(/Key conflict with/)).toBeNull()
  })

  it('flags a terminal key an app chord takes first', () => {
    useSettingsStore.setState({ terminalKeys: { 'Ctrl+Shift+P': { type: 'escape', value: 'p' } } })
    render(<KeyboardSection />)
    expect(within(row(/ESC p/)).getByText('Key conflict with Command Palette')).toBeInTheDocument()
  })

  it('adds a key that sends text to the terminal, refusing keys that type, and removes it', async () => {
    render(<KeyboardSection />)
    await userEvent.click(screen.getByRole('button', { name: 'Add a terminal key' }))
    press('k', { code: 'KeyK' })
    expect(screen.getByRole('alert')).toHaveTextContent(/K can’t be used: single keys/)
    press('K', { ctrlKey: true, altKey: true, code: 'KeyK' })
    await pickAction('Custom bytes (advanced)')
    await userEvent.type(screen.getByRole('textbox', { name: 'What to send' }), 'clear\\r')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(useSettingsStore.getState().terminalKeys).toEqual({
      'Ctrl+Alt+K': { type: 'text', value: 'clear\\r' },
    })
    expect(within(row(/clear\\r/)).getByText('Ctrl+Alt+K')).toBeInTheDocument()
    expect(within(row(/clear\\r/)).getByText('Custom')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Remove Ctrl+Alt+K' }))
    expect(useSettingsStore.getState().terminalKeys).toEqual({})
    expect(screen.queryByText('clear\\r')).toBeNull()
  })

  it('adds a key by recording it and picking an action, with no bytes to type', async () => {
    render(<KeyboardSection />)
    await userEvent.click(screen.getByRole('button', { name: 'Add a terminal key' }))
    press('K', { ctrlKey: true, altKey: true, code: 'KeyK' })
    expect(screen.queryByRole('textbox', { name: 'What to send' })).toBeNull()
    await pickAction('Delete previous word')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(useSettingsStore.getState().terminalKeys).toEqual({
      'Ctrl+Alt+K': { type: 'hex', value: '0x1b 0x7f' },
    })
    expect(within(row(/Delete previous word/)).getByText('Ctrl+Alt+K')).toBeInTheDocument()
  })

  it('edits a key by its action, and shows the bytes only for one no action matches', async () => {
    useSettingsStore.setState({
      terminalKeys: {
        'Ctrl+Alt+K': { type: 'hex', value: '0x01' },
        'Ctrl+Alt+J': { type: 'text', value: 'ls\\r' },
      },
    })
    render(<KeyboardSection />)
    await userEvent.click(screen.getByRole('button', { name: 'Edit Ctrl+Alt+K' }))
    expect(screen.getByRole('combobox', { name: 'Action' })).toHaveTextContent('Start of line')
    expect(screen.queryByRole('textbox', { name: 'What to send' })).toBeNull()
    await pickAction('End of line')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(useSettingsStore.getState().terminalKeys['Ctrl+Alt+K']).toEqual({
      type: 'hex',
      value: '0x05',
    })
    await userEvent.click(screen.getByRole('button', { name: 'Edit Ctrl+Alt+J' }))
    expect(screen.getByRole('combobox', { name: 'Action' })).toHaveTextContent(
      'Custom bytes (advanced)',
    )
    expect(screen.getByRole('textbox', { name: 'What to send' })).toHaveValue('ls\\r')
  })

  it('says what is wrong with a value it cannot send and keeps the editor open', async () => {
    render(<KeyboardSection />)
    await userEvent.click(screen.getByRole('button', { name: 'Add a terminal key' }))
    press('K', { ctrlKey: true, altKey: true, code: 'KeyK' })
    await pickAction('Custom bytes (advanced)')
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
    await pickAction('Custom bytes (advanced)')
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
    await change('Ctrl+Shift+P', 'Command Palette')
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
    expect(groupNames()).toEqual(['Text editing (sent to the terminal)'])
    expect(screen.getAllByRole('row')).toHaveLength(3)
    await userEvent.click(screen.getByRole('button', { name: 'Edit Ctrl+Alt+K' }))
    const value = screen.getByRole('textbox', { name: 'What to send' })
    expect(value).toHaveValue('k')
    await userEvent.clear(value)
    await userEvent.type(value, 'j')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(useSettingsStore.getState().terminalKeys).toEqual({
      'Ctrl+Alt+K': { type: 'escape', value: 'j' },
    })
    await userEvent.click(screen.getByRole('button', { name: 'My changes (1)' }))
    await userEvent.click(screen.getByRole('button', { name: 'Revert Ctrl+Alt+K' }))
    expect(useSettingsStore.getState().terminalKeys).toEqual({})
  })

  it('removes only the chord whose × is pressed, down to unassigned, and reset brings them back', async () => {
    render(<KeyboardSection />)
    await userEvent.click(
      screen.getByRole('button', { name: 'Remove Ctrl+Shift+X from Zoom Pane' }),
    )
    expect(useSettingsStore.getState().keybindings['pane.zoom']).toBe('terminal:Ctrl+Shift+Enter')
    const zoom = within(row(/Zoom Pane/))
    expect(zoom.getByText('Ctrl+Shift+Enter')).toBeInTheDocument()
    expect(zoom.queryByText('Ctrl+Shift+X')).toBeNull()
    expect(zoom.getByText('Custom')).toBeInTheDocument()
    expect(zoom.getByText('removes Ctrl+Shift+X')).toBeInTheDocument()

    await userEvent.click(
      screen.getByRole('button', { name: 'Remove Ctrl+Shift+Enter from Zoom Pane' }),
    )
    expect(useSettingsStore.getState().keybindings['pane.zoom']).toBeNull()
    expect(within(row(/Zoom Pane/)).getByText('Unassigned')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Reset Zoom Pane' }))
    expect(useSettingsStore.getState().keybindings).toEqual({})
    expect(within(row(/Zoom Pane/)).getByText('Ctrl+Shift+X')).toBeInTheDocument()
  })

  it('binds Search Everywhere to Shift twice and turns it off with ×', async () => {
    render(<KeyboardSection />)
    expect(within(row(/Search Everywhere/)).getByText('Shift+Shift')).toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('button', { name: 'Remove Shift+Shift from Search Everywhere' }),
    )
    expect(useSettingsStore.getState().keybindings['palette.searchEverywhere']).toBeNull()
    expect(within(row(/Search Everywhere/)).getByText('Unassigned')).toBeInTheDocument()
  })

  it('records Shift twice for another command and takes it from Search Everywhere on confirm', async () => {
    render(<KeyboardSection />)
    await change('Ctrl+Shift+P', 'Command Palette')
    tapShift()
    tapShift()
    await userEvent.click(await screen.findByRole('button', { name: /Replace/ }))
    expect(useSettingsStore.getState().keybindings).toEqual({
      'palette.toggle': 'Shift+Shift',
      'palette.searchEverywhere': null,
    })
  })

  it('refuses Shift twice for a terminal-only command and keeps recording', async () => {
    render(<KeyboardSection />)
    await change('Ctrl+Shift+C', 'Copy (terminal)')
    tapShift()
    tapShift()
    expect(within(row(/Copy \(terminal\)/)).getByRole('alert')).toHaveTextContent(
      /Shift\+Shift can’t be used/,
    )
    expect(useSettingsStore.getState().keybindings).toEqual({})
    expect(screen.queryByRole('button', { name: /Replace/ })).toBeNull()
  })

  it('names Shift twice set on a terminal-only command in settings as ignored', () => {
    useSettingsStore.setState({ keybindings: { 'terminal.scrollToTop': 'Shift+Shift' } })
    render(<KeyboardSection />)
    expect(
      within(row(/Scroll to Top/)).getByText(/“Shift\+Shift” is ignored on this computer/),
    ).toBeInTheDocument()
  })

  it('re-records only the clicked chord and keeps it in the terminal scope', async () => {
    render(<KeyboardSection />)
    await change('Ctrl+Shift+Enter', 'Zoom Pane')
    expect(within(row(/Zoom Pane/)).getByText(/Press a shortcut/)).toBeInTheDocument()
    expect(within(row(/Zoom Pane/)).getByText('Ctrl+Shift+X')).toBeInTheDocument()
    press('Z', { ctrlKey: true, altKey: true, code: 'KeyZ' })
    expect(useSettingsStore.getState().keybindings['pane.zoom']).toEqual([
      'terminal:Ctrl+Alt+Z',
      'Ctrl+Shift+X',
    ])
    const zoom = within(row(/Zoom Pane/))
    expect(zoom.getByText('Ctrl+Alt+Z')).toBeInTheDocument()
    expect(zoom.getByText('in a terminal')).toBeInTheDocument()
  })

  it('adds a chord next to the existing one, and adding to an unassigned command binds it', async () => {
    render(<KeyboardSection />)
    await add('Command Palette')
    press('Y', { ctrlKey: true, altKey: true, code: 'KeyY' })
    expect(useSettingsStore.getState().keybindings['palette.toggle']).toEqual([
      'Ctrl+Shift+P',
      'Ctrl+Alt+Y',
    ])
    const palette = within(row(/Command Palette/))
    expect(palette.getByText('Ctrl+Shift+P')).toBeInTheDocument()
    expect(palette.getByText('Ctrl+Alt+Y')).toBeInTheDocument()

    await add('New Browser Tab')
    press('B', { ctrlKey: true, altKey: true, code: 'KeyB' })
    expect(within(row(/New Browser Tab/)).getByText('Ctrl+Alt+B')).toBeInTheDocument()
  })

  it('cancels adding on Escape without changing anything', async () => {
    render(<KeyboardSection />)
    await add('Command Palette')
    press('Escape')
    expect(useSettingsStore.getState().keybindings).toEqual({})
    expect(within(row(/Command Palette/)).queryByText(/Press a shortcut/)).toBeNull()
  })

  it('floats the conflict notice over the table instead of adding to the row', async () => {
    render(<KeyboardSection />)
    const rowsBefore = screen.getAllByRole('row').length
    await change('Ctrl+Shift+B', 'Toggle Sidebar')
    press('P', { ctrlKey: true, shiftKey: true, code: 'KeyP' })
    const text = screen.getByText(/Ctrl\+Shift\+P is already the shortcut for Command Palette/)
    const notice = text.closest('[data-slot="key-notice"]')
    expect(notice?.closest('tr')).toBe(row(/Toggle Sidebar/))
    expect(screen.getAllByRole('row')).toHaveLength(rowsBefore)
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(document.querySelector('[data-slot="key-notice"]')).toBeNull()
  })

  it('labels only the rows that differ, and marks custom rows with a side bar', () => {
    useSettingsStore.setState({ keybindings: { 'palette.toggle': 'Ctrl+Shift+Y' } })
    render(<KeyboardSection />)
    const palette = row(/Command Palette/)
    expect(palette).toHaveAttribute('data-source', 'user')
    expect(within(palette).getByText('Custom')).toBeInTheDocument()
    expect(palette.querySelector('[data-slot="custom-bar"]')).not.toBeNull()
    const sidebar = row(/Toggle Sidebar/)
    expect(sidebar).toHaveAttribute('data-source', 'default')
    expect(sidebar.querySelector('[data-slot="custom-bar"]')).toBeNull()
    expect(within(sidebar).queryByText('Custom')).toBeNull()
    expect(screen.getAllByText('Custom')).toHaveLength(1)
  })

  it('groups commands by what they act on, text editing last', () => {
    render(<KeyboardSection />)
    const groups = groupNames()
    expect(groups.slice(0, 6)).toEqual([
      'Workspace and window',
      'Pane',
      'Terminal',
      'View',
      'App',
      'Browser',
    ])
    expect(groups.at(-1)).toBe('Text editing (sent to the terminal)')
    const titles = screen.getAllByRole('row').map((r) => r.textContent ?? '')
    const at = (re: RegExp): number => titles.findIndex((t) => re.test(t))
    expect(at(/^Pane/)).toBeLessThan(at(/Zoom Pane/))
    expect(at(/Zoom Pane/)).toBeLessThan(at(/^Terminal$/))
    expect(at(/^Workspace and window/)).toBeLessThan(at(/New Terminal Tab/))
  })

  it('names text editing keys by their action, bytes in small type, raw values as they are', () => {
    useSettingsStore.setState({
      terminalKeys: { 'Ctrl+Alt+K': { type: 'text', value: 'clear\\r' } },
    })
    render(<KeyboardSection />)
    const word = within(row(/Delete previous word/))
    expect(word.getByText('0x17')).toBeInTheDocument()
    expect(word.getByText('Ctrl+Backspace')).toBeInTheDocument()
    const custom = within(row(/clear\\r/))
    expect(custom.getByText('clear\\r')).toBeInTheDocument()
    expect(custom.getByText('Text')).toBeInTheDocument()
    expect(screen.queryByText('Send to terminal')).toBeNull()
  })

  it('finds a text editing key by its action name', async () => {
    render(<KeyboardSection />)
    await userEvent.type(screen.getByRole('textbox', { name: 'Search shortcuts' }), 'previous word')
    expect(screen.getByText('Delete previous word')).toBeInTheDocument()
    expect(screen.queryByText('Command Palette')).toBeNull()
  })

  it('keeps fixed column widths while switching app shortcuts and text editing', async () => {
    useExtensionsStore.setState({ list: [keymapExtension] })
    vi.mocked(window.ostia.keymaps.load).mockResolvedValue({
      ok: true,
      keymap: {
        extId: 'keys',
        id: 'alt',
        label: 'Alt keys',
        bindings: { 'palette.toggle': 'Ctrl+Alt+P' },
        skipped: [],
      },
    })
    syncKeymaps()
    render(<KeyboardSection />)
    const widths = ['w-[42%]', 'w-[36%]', 'w-[22%]']
    expect(columnWidths()).toEqual(widths)
    await pickPreset('App shortcuts', 'Alt keys')
    expect(await screen.findByText(/Switching to Alt keys changes/)).toBeInTheDocument()
    expect(columnWidths()).toEqual(widths)
    await userEvent.click(screen.getByRole('button', { name: 'Apply Alt keys' }))
    expect(await within(row(/Command Palette/)).findByText('Ctrl+Alt+P')).toBeInTheDocument()
    expect(columnWidths()).toEqual(widths)
    await userEvent.click(screen.getByRole('button', { name: 'Details for Command Palette' }))
    expect(columnWidths()).toEqual(widths)
    await applyPreset('Text editing', 'No translation')
    expect(columnWidths()).toEqual(widths)
  })
})

const altKeys = {
  ok: true as const,
  keymap: {
    extId: 'keys',
    id: 'alt',
    label: 'Alt keys',
    bindings: { 'palette.toggle': 'Ctrl+Alt+P', 'view.toggleRail': null },
    skipped: [],
  },
}

const preview = (): HTMLElement => {
  const el = document.querySelector<HTMLElement>('[data-slot="preset-preview"]')
  if (!el) throw new Error('no preview')
  return el
}

const detail = (): HTMLElement => {
  const el = document.querySelector<HTMLElement>('[data-slot="binding-detail"]')
  if (!el) throw new Error('no detail')
  return el
}

const layer = (name: string): HTMLElement => {
  const el = detail().querySelector<HTMLElement>(`[data-layer="${name}"]`)
  if (!el) throw new Error(`no ${name} layer`)
  return el
}

const toggleFor = (command: string): HTMLElement =>
  screen.getByRole('button', { name: `Details for ${command}` })

describe('KeyboardSection layered view', () => {
  beforeAll(() => {
    if (!commands.has('palette.toggle')) registerBuiltinCommands()
  })

  afterEach(() => {
    stopKeymapSync()
    cleanup()
    useSettingsStore.setState(initialSettings, true)
    useExtensionsStore.setState(initialExtensions, true)
    useKeymapStore.setState(initialKeymap, true)
  })

  describe('preset preview', () => {
    it('lists what an app preset would change, keeps everything until Apply, and Cancel leaves it as it was', async () => {
      useExtensionsStore.setState({ list: [keymapExtension] })
      useSettingsStore.setState({ keybindings: { 'view.toggleRail': 'Ctrl+Shift+J' } })
      vi.mocked(window.ostia.keymaps.load).mockResolvedValue(altKeys)
      syncKeymaps()
      render(<KeyboardSection />)
      await pickPreset('App shortcuts', 'Alt keys')
      expect(
        await screen.findByText('Switching to Alt keys changes these keys (2)'),
      ).toBeInTheDocument()
      expect(window.ostia.keymaps.load).toHaveBeenCalledWith('keys/alt')
      expect(useSettingsStore.getState().keymap).toBeNull()
      expect(within(row(/Command Palette/)).getByText('Ctrl+Shift+P')).toBeInTheDocument()
      const items = within(preview()).getAllByRole('listitem')
      const palette = items.find((li) => li.textContent?.includes('Command Palette'))
      expect(palette).toHaveTextContent('Ctrl+Shift+PCtrl+Alt+P')
      const sidebar = items.find((li) => li.textContent?.includes('Toggle Sidebar'))
      expect(sidebar).toHaveTextContent('Ctrl+Shift+BNone')
      expect(within(sidebar as HTMLElement).getByText('yours stays')).toBeInTheDocument()
      expect(
        within(preview()).getByText('Your custom keys stay on top: Toggle Sidebar'),
      ).toBeInTheDocument()
      expect(
        within(presets('App shortcuts')).getByRole('button', { name: 'Alt keys' }),
      ).toHaveAttribute('data-previewing')
      expect(applied('App shortcuts')).toBe('Ostia')

      await userEvent.click(within(preview()).getByRole('button', { name: 'Cancel' }))
      expect(document.querySelector('[data-slot="preset-preview"]')).toBeNull()
      expect(useSettingsStore.getState().keymap).toBeNull()
      expect(useSettingsStore.getState().keybindings).toEqual({
        'view.toggleRail': 'Ctrl+Shift+J',
      })

      await applyPreset('App shortcuts', 'Alt keys')
      expect(useSettingsStore.getState().keymap).toBe('keys/alt')
      expect(document.querySelector('[data-slot="preset-preview"]')).toBeNull()
      expect(
        await within(presets('App shortcuts').closest('section') as HTMLElement).findByRole(
          'button',
          { name: '2 keys differ from Ostia' },
        ),
      ).toBeInTheDocument()
      expect(useSettingsStore.getState().keybindings).toEqual({
        'view.toggleRail': 'Ctrl+Shift+J',
      })
    })

    it('says when a preset changes nothing, and picking the applied one closes the preview', async () => {
      render(<KeyboardSection />)
      expect(screen.getAllByText('Same as default')).toHaveLength(2)
      expect(
        screen.getByText(
          'Your own changes always stay on top; switching presets doesn’t touch them.',
        ),
      ).toBeInTheDocument()
      await pickPreset('Text editing', 'No translation')
      expect(
        within(preview()).getByText('Switching to No translation changes these keys (5)'),
      ).toBeInTheDocument()
      expect(within(preview()).getAllByText('Not translated')).toHaveLength(5)
      await pickPreset('Text editing', 'Ostia standard')
      expect(document.querySelector('[data-slot="preset-preview"]')).toBeNull()
      expect(useSettingsStore.getState().terminalKeymap).toBeNull()
    })

    it('says when an app preset cannot be loaded for the preview', async () => {
      useExtensionsStore.setState({ list: [keymapExtension] })
      vi.mocked(window.ostia.keymaps.load).mockResolvedValue({ ok: false, error: 'gone' })
      render(<KeyboardSection />)
      await pickPreset('App shortcuts', 'Alt keys')
      expect(await screen.findByText('Alt keys couldn’t be loaded (gone).')).toBeInTheDocument()
      expect(useSettingsStore.getState().keymap).toBeNull()
    })
  })

  describe('my changes', () => {
    it('lists your custom, removed and preset keys in three sections and reverts each', async () => {
      useExtensionsStore.setState({ list: [keymapExtension] })
      useSettingsStore.setState({
        keymap: 'keys/alt',
        keybindings: {
          find: 'Ctrl+Alt+F',
          'tab.new': 'Ctrl+Alt+T',
          'pane.zoom': null,
        },
        terminalKeys: { 'Ctrl+Alt+K': { type: 'text', value: 'k' }, 'Alt+Left': null },
      })
      vi.mocked(window.ostia.keymaps.load).mockResolvedValue(altKeys)
      syncKeymaps()
      render(<KeyboardSection />)
      await userEvent.click(await screen.findByRole('button', { name: '2 keys differ from Ostia' }))
      expect(screen.getByRole('button', { name: 'My changes (7)' })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
      expect(screen.queryByRole('textbox', { name: 'Search shortcuts' })).toBeNull()
      expect(
        groupNames().map((g) => g.replace(/Revert these|Change all back to Ostia/, '')),
      ).toEqual(['You customized (3)', 'You removed (2)', 'App shortcuts “Alt keys” brings (2)'])
      const find = row(/Find \(terminal\)/)
      expect(find).toHaveAttribute('data-change', 'custom')
      expect(within(find).getByText('Ctrl+Alt+F')).toBeInTheDocument()
      expect(within(find).getByText('was Ctrl+Shift+F')).toBeInTheDocument()
      expect(within(row(/pane\.zoom/)).getByText('Unassigned')).toBeInTheDocument()
      expect(within(row(/Back one word/)).getByText('Not translated')).toBeInTheDocument()
      expect(within(row(/Command Palette/)).getByText('Ostia: Ctrl+Shift+P')).toBeInTheDocument()
      expect(within(row(/Command Palette/)).getByText('Ctrl+Alt+P')).toBeInTheDocument()

      await userEvent.click(screen.getByRole('button', { name: 'Revert Find (terminal)' }))
      expect(useSettingsStore.getState().keybindings).toEqual({
        'tab.new': 'Ctrl+Alt+T',
        'pane.zoom': null,
      })
      await userEvent.click(screen.getByRole('button', { name: 'Revert all in You removed (2)' }))
      expect(useSettingsStore.getState().keybindings).toEqual({ 'tab.new': 'Ctrl+Alt+T' })
      expect(useSettingsStore.getState().terminalKeys).toEqual({
        'Ctrl+Alt+K': { type: 'text', value: 'k' },
      })
      await userEvent.click(
        screen.getByRole('button', { name: 'Change App shortcuts back to Ostia' }),
      )
      expect(useSettingsStore.getState().keymap).toBe('ostia')
      expect(groupNames()).toEqual(['You customized (2)Revert these'])
    })

    it('asks before reverting everything, and Cancel keeps it all', async () => {
      useSettingsStore.setState({
        terminalKeymap: 'none',
        keybindings: { find: 'Ctrl+Alt+F' },
        terminalKeys: { 'Ctrl+Alt+K': { type: 'text', value: 'k' } },
      })
      render(<KeyboardSection />)
      await userEvent.click(screen.getByRole('button', { name: 'My changes (7)' }))
      await userEvent.click(screen.getByRole('button', { name: 'Revert everything to Ostia' }))
      expect(
        screen.getByText('This removes your 7 changes and switches both presets back to Ostia.'),
      ).toBeInTheDocument()
      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(useSettingsStore.getState().keybindings).toEqual({ find: 'Ctrl+Alt+F' })
      expect(useSettingsStore.getState().terminalKeymap).toBe('none')

      await userEvent.click(screen.getByRole('button', { name: 'Revert everything to Ostia' }))
      await userEvent.click(screen.getByRole('button', { name: 'Revert everything' }))
      expect(useSettingsStore.getState().keybindings).toEqual({})
      expect(useSettingsStore.getState().terminalKeys).toEqual({})
      expect(useSettingsStore.getState().terminalKeymap).toBe('ostia')
      expect(useSettingsStore.getState().keymap).toBe('ostia')
      expect(screen.getByRole('button', { name: 'My changes (0)' })).toBeInTheDocument()
    })
  })

  describe('expanded row', () => {
    it('shows the three layers, marks the one in effect, and edits keys inside', async () => {
      useSettingsStore.setState({ keybindings: { 'pane.zoom': 'Ctrl+Alt+Z' } })
      render(<KeyboardSection />)
      expect(document.querySelector('[data-slot="binding-detail"]')).toBeNull()
      await userEvent.click(toggleFor('Zoom Pane'))
      expect(toggleFor('Zoom Pane')).toHaveAttribute('aria-expanded', 'true')
      expect(layer('user')).toHaveAttribute('data-effective')
      expect(layer('user')).toHaveTextContent('Ctrl+Alt+Z')
      expect(layer('user')).toHaveTextContent('in effect')
      expect(layer('default')).not.toHaveAttribute('data-effective')
      expect(layer('default')).toHaveTextContent('Ctrl+Shift+EnterCtrl+Shift+X')
      expect(detail().querySelector('[data-layer="preset"]')).toBeNull()
      expect(within(row(/Zoom Pane/)).queryByRole('button', { name: /^Change / })).toBeNull()

      await add('Zoom Pane')
      press('Q', { ctrlKey: true, altKey: true, code: 'KeyQ' })
      expect(useSettingsStore.getState().keybindings['pane.zoom']).toEqual([
        'Ctrl+Alt+Z',
        'Ctrl+Alt+Q',
      ])
      await userEvent.click(
        within(detail()).getByRole('button', { name: 'Remove Ctrl+Alt+Z from Zoom Pane' }),
      )
      expect(useSettingsStore.getState().keybindings['pane.zoom']).toBe('Ctrl+Alt+Q')

      await userEvent.click(within(detail()).getByRole('button', { name: 'Bind no keys' }))
      expect(useSettingsStore.getState().keybindings['pane.zoom']).toBeNull()
      expect(layer('user')).toHaveTextContent('No keys')
      expect(within(detail()).getByRole('button', { name: 'Bind no keys' })).toBeDisabled()

      await userEvent.click(within(detail()).getByRole('button', { name: 'Back to Ostia’s value' }))
      expect(useSettingsStore.getState().keybindings).toEqual({})
      expect(layer('default')).toHaveAttribute('data-effective')
      expect(layer('user')).toHaveTextContent('Not set')
      expect(within(detail()).queryByRole('button', { name: /^Back to/ })).toBeNull()
    })

    it('names the preset layer and goes back to its value', async () => {
      useExtensionsStore.setState({ list: [keymapExtension] })
      useSettingsStore.setState({
        keymap: 'keys/alt',
        keybindings: { 'palette.toggle': 'Ctrl+Shift+Y' },
      })
      vi.mocked(window.ostia.keymaps.load).mockResolvedValue(altKeys)
      syncKeymaps()
      render(<KeyboardSection />)
      await screen.findByRole('button', { name: '2 keys differ from Ostia' })
      await userEvent.click(toggleFor('Command Palette'))
      expect(layer('preset')).toHaveTextContent('Alt keys')
      expect(layer('preset')).toHaveTextContent('Ctrl+Alt+P')
      expect(layer('user')).toHaveAttribute('data-effective')
      await userEvent.click(
        within(detail()).getByRole('button', { name: 'Back to Alt keys’s value' }),
      )
      expect(useSettingsStore.getState().keybindings).toEqual({})
      expect(layer('preset')).toHaveAttribute('data-effective')
    })

    it('moves with ↑↓, expands with Enter and collapses with Esc without closing settings', async () => {
      const behind = vi.fn()
      window.addEventListener('keydown', behind)
      try {
        render(<KeyboardSection />)
        const toggles = screen
          .getAllByRole('button', { name: /^Details for / })
          .map((b) => b.getAttribute('aria-label'))
        const first = toggleFor(toggles[0]?.replace('Details for ', '') ?? '')
        act(() => first.focus())
        await userEvent.keyboard('{ArrowDown}')
        expect(document.activeElement).toHaveAttribute('aria-label', toggles[1])
        await userEvent.keyboard('{ArrowDown}')
        expect(document.activeElement).toHaveAttribute('aria-label', toggles[2])
        await userEvent.keyboard('{ArrowUp}')
        expect(document.activeElement).toHaveAttribute('aria-label', toggles[1])
        await userEvent.keyboard('{Enter}')
        expect(document.activeElement).toHaveAttribute('aria-expanded', 'true')
        expect(detail()).toBeInTheDocument()
        behind.mockClear()
        await userEvent.keyboard('{Escape}')
        expect(document.querySelector('[data-slot="binding-detail"]')).toBeNull()
        expect(document.activeElement).toHaveAttribute('aria-label', toggles[1])
        expect(document.activeElement).toHaveAttribute('aria-expanded', 'false')
        expect(behind).not.toHaveBeenCalled()

        await userEvent.keyboard('{Enter}')
        const inside = within(detail()).getByRole('button', { name: /^Add a shortcut for / })
        act(() => inside.focus())
        await userEvent.keyboard('{Escape}')
        expect(document.querySelector('[data-slot="binding-detail"]')).toBeNull()
        expect(document.activeElement).toHaveAttribute('aria-label', toggles[1])

        const last = toggleFor('Ctrl+→')
        act(() => last.focus())
        await userEvent.keyboard('{ArrowDown}')
        expect(document.activeElement).toBe(last)
      } finally {
        window.removeEventListener('keydown', behind)
      }
    })

    it('opens one row at a time and shows a text editing key’s layers', async () => {
      render(<KeyboardSection />)
      await userEvent.click(toggleFor('Command Palette'))
      await userEvent.click(toggleFor('Ctrl+Backspace'))
      expect(document.querySelectorAll('[data-slot="binding-detail"]')).toHaveLength(1)
      expect(toggleFor('Command Palette')).toHaveAttribute('aria-expanded', 'false')
      expect(layer('default')).toHaveTextContent('Ostia standard')
      expect(layer('default')).toHaveTextContent('Delete previous word')
      expect(layer('default')).toHaveAttribute('data-effective')
      expect(layer('user')).toHaveTextContent('Not set')
      await userEvent.click(within(detail()).getByRole('button', { name: 'Bind no keys' }))
      expect(useSettingsStore.getState().terminalKeys).toEqual({ 'Ctrl+Backspace': null })
      expect(document.querySelector('[data-slot="binding-detail"]')).toBeNull()
    })
  })
})
