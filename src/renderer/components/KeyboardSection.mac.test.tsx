import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { registerBuiltinCommands } from '../commands/builtins'
import { commands } from '../commands/registry'
import { useSettingsStore } from '../stores/settingsStore'
import { KeyboardSection } from './KeyboardSection'

vi.mock('../platform', () => ({ platform: 'darwin', isMac: true, isLinux: false }))

const initialSettings = useSettingsStore.getState()

const editButtons = (): string[] => {
  const buttons = screen.getAllByRole('button', { name: /^Edit / })
  return buttons.map((b) => b.getAttribute('aria-label') ?? '').sort()
}

const row = (name: RegExp): HTMLElement => {
  const cell = screen.getAllByRole('cell').find((c) => name.test(c.textContent ?? ''))
  const tr = cell?.closest('tr')
  if (!tr) throw new Error(`no row for ${name}`)
  return tr
}

describe('KeyboardSection on macOS', () => {
  beforeAll(() => {
    if (!commands.has('palette.toggle')) registerBuiltinCommands()
  })

  afterEach(() => {
    cleanup()
    useSettingsStore.setState(initialSettings, true)
  })

  it('lists the default terminal keys and switches to Natural Text Editing', async () => {
    render(<KeyboardSection />)
    const defaults = ['⌘Backspace', '⌘←', '⌘→', '⌥←', '⌥→', '⌥Backspace', '⌥Delete', '⌘Delete']
    expect(editButtons()).toEqual(defaults.map((keys) => `Edit ${keys}`).sort())
    expect(screen.getByRole('combobox', { name: 'App shortcuts' })).toHaveTextContent('Ostia')
    expect(screen.getByRole('combobox', { name: 'Text editing' })).toHaveTextContent(
      'Ostia standard',
    )
    await userEvent.click(screen.getByRole('combobox', { name: 'Text editing' }))
    await userEvent.click(
      await screen.findByRole('option', { name: 'Natural Text Editing (iTerm2)' }),
    )
    expect(useSettingsStore.getState().terminalKeymap).toBe('natural-text-editing')
    expect(useSettingsStore.getState().keymap).toBeNull()
    expect(screen.getByText(/sends \^D for Forward Delete on its own/)).toBeInTheDocument()
    expect(editButtons()).toContain('Edit Delete')
    expect(editButtons()).not.toContain('Edit ⌘Delete')
    expect(useSettingsStore.getState().terminalKeys).toEqual({})
  })

  it('sends nothing with No translation and lists no terminal keys', async () => {
    render(<KeyboardSection />)
    await userEvent.click(screen.getByRole('combobox', { name: 'Text editing' }))
    await userEvent.click(await screen.findByRole('option', { name: 'No translation' }))
    expect(useSettingsStore.getState().terminalKeymap).toBe('none')
    expect(screen.queryAllByRole('button', { name: /^Edit / })).toEqual([])
  })

  it('removes a preset key with null and Reset all brings it back', async () => {
    render(<KeyboardSection />)
    await userEvent.click(screen.getByRole('button', { name: 'Remove ⌥←' }))
    expect(useSettingsStore.getState().terminalKeys).toEqual({ 'Alt+Left': null })
    expect(editButtons()).not.toContain('Edit ⌥←')
    await userEvent.click(screen.getByRole('button', { name: 'Reset all' }))
    expect(useSettingsStore.getState().terminalKeys).toEqual({})
    expect(editButtons()).toContain('Edit ⌥←')
  })

  it('changes a preset key, marks it custom, and resets it to the preset', async () => {
    render(<KeyboardSection />)
    expect(screen.queryByRole('button', { name: 'Reset ⌘←' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Edit ⌘←' }))
    const value = screen.getByRole('textbox', { name: 'What to send' })
    expect(value).toHaveValue('0x01')
    await userEvent.clear(value)
    await userEvent.type(value, '0x02')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(useSettingsStore.getState().terminalKeys).toEqual({
      'Cmd+Left': { type: 'hex', value: '0x02' },
    })
    expect(within(row(/0x02/)).getByText('Custom')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Reset ⌘←' }))
    expect(useSettingsStore.getState().terminalKeys).toEqual({})
  })

  it('shows ⌘K for the palette next to ⇧⌘P, and ⌘D as a split in a terminal only', () => {
    render(<KeyboardSection />)
    const palette = row(/Command Palette/)
    expect(palette).toHaveTextContent('⌘⇧P')
    expect(palette).toHaveTextContent('⌘K')
    expect(palette).not.toHaveTextContent('in a terminal')
    const split = row(/Split Pane Right/)
    expect(split).toHaveTextContent('⌘Din a terminal')
    expect(split).toHaveTextContent('⌥⌘\\')
  })

  it('offers to take ⌘← from the terminal when a command is recorded on it', async () => {
    render(<KeyboardSection />)
    await userEvent.click(screen.getByRole('button', { name: 'Change ⌘K for Command Palette' }))
    act(() => {
      fireEvent.keyDown(window, { key: 'ArrowLeft', code: 'ArrowLeft', metaKey: true })
    })
    expect(
      screen.getByText('⌘← sends 0x01 to the terminal. Replacing removes it there.'),
    ).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Replace' }))
    expect(useSettingsStore.getState().keybindings['palette.toggle']).toEqual([
      'Shift+Cmd+P',
      'Cmd+Left',
    ])
    expect(useSettingsStore.getState().terminalKeys).toEqual({ 'Cmd+Left': null })
  })

  it('removes ⌘K from the palette and keeps ⇧⌘P', async () => {
    render(<KeyboardSection />)
    await userEvent.click(screen.getByRole('button', { name: 'Remove ⌘K from Command Palette' }))
    expect(useSettingsStore.getState().keybindings['palette.toggle']).toBe('Shift+Cmd+P')
    const palette = row(/Command Palette/)
    expect(palette).toHaveTextContent('⌘⇧P')
    expect(screen.queryByRole('button', { name: 'Change ⌘K for Command Palette' })).toBeNull()
    expect(within(palette).getByText('removes ⌘K')).toBeInTheDocument()
  })

  it('names the text editing actions and labels only the key Natural Text Editing changes', async () => {
    render(<KeyboardSection />)
    expect(within(row(/Start of line/)).getByText('⌘←')).toBeInTheDocument()
    expect(within(row(/Delete line/)).getByText('0x15')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('combobox', { name: 'Text editing' }))
    await userEvent.click(
      await screen.findByRole('option', { name: 'Natural Text Editing (iTerm2)' }),
    )
    const forward = row(/Delete character ahead/)
    expect(within(forward).getByText('Natural Text Editing (iTerm2)')).toBeInTheDocument()
    expect(forward).toHaveAttribute('data-source', 'preset')
    expect(within(row(/Start of line/)).queryByText('Natural Text Editing (iTerm2)')).toBeNull()
    expect(row(/Start of line/)).toHaveAttribute('data-source', 'default')
  })
})
