import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { registerBuiltinCommands } from '../commands/builtins'
import { commands } from '../commands/registry'
import { zhHant } from '../i18n/dict'
import { languagesFrom } from '../lib/languagePacks'
import { usePluginsStore } from '../stores/pluginsStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { CommandPalette } from './CommandPalette'
import { ChordRecorder, KeyboardSection } from './KeyboardSection'

const initialSettings = useSettingsStore.getState()
const initialPlugins = usePluginsStore.getState()

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
    useUIStore.setState({ paletteOpen: false })
  })

  it('lists commands with their current shortcut, including palette commands without one', () => {
    render(<KeyboardSection />)
    expect(within(row(/Command Palette/)).getByText('Ctrl+Shift+P')).toBeInTheDocument()
    expect(within(row(/Split Pane Right/)).getByText('Unassigned')).toBeInTheDocument()
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
    press('Tab', { ctrlKey: true, code: 'Tab' })
    expect(screen.getByRole('alert')).toHaveTextContent(/Tab belongs to the shell/)
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
})
