import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { registerBuiltinCommands } from '../commands/builtins'
import { commands } from '../commands/registry'
import { useUIStore } from '../stores/uiStore'
import { CommandPalette } from './CommandPalette'

/**
 * CommandPalette is a cmdk dialog gated by uiStore.paletteOpen. It lists the visible
 * (non-hidden) commands from the registry, grouped by category; cmdk owns the fuzzy
 * filter + keyboard nav, and selecting a row calls the same `commands.exec` the buttons
 * use, then closes the palette.
 *
 * These tests assert REAL behaviour: the closed state mounts nothing, the open dialog lists
 * the visible built-ins (hidden ones excluded), typing filters the rows, and selecting a row
 * runs it through `commands.exec` and closes the palette.
 *
 * Mocking: none beyond the per-test window.pine fake from test/setup.ts (the palette never
 * touches it). commands.exec is spied (vi.spyOn), not module-mocked. Built-ins are registered
 * once in beforeAll — the registry is a module singleton, isolated per test file.
 */

describe('CommandPalette', () => {
  let uiInit: ReturnType<typeof useUIStore.getState>

  beforeAll(() => {
    if (!commands.has('palette.toggle')) registerBuiltinCommands()
    uiInit = useUIStore.getState()
  })

  afterEach(() => {
    // Unmount BEFORE resetting the store so a still-mounted tree can't fire stray effects
    // against about-to-be-restored state/mocks.
    cleanup()
    useUIStore.setState(uiInit, true)
    vi.restoreAllMocks()
  })

  it('does not mount the palette dialog while paletteOpen is false', () => {
    // Default paletteOpen is false — the Base-UI Dialog keeps its content unmounted, so
    // none of the cmdk surface (dialog / input / rows) is in the document.
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
    // `pane.split` is registered hidden — it must not surface as a row (its shortcut id
    // would be the exact text 'pane.split'; visible splits are 'pane.splitRight/Down').
    expect(screen.queryByText('pane.split')).toBeNull()
  })

  it('filters the list to matching commands as the user types', async () => {
    useUIStore.setState({ paletteOpen: true })
    render(<CommandPalette />)
    const input = await screen.findByRole('combobox')

    await userEvent.type(input, 'Open')

    expect(await screen.findByRole('option', { name: /Open Settings/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /New Session/ })).toBeNull()
    expect(screen.queryByRole('option', { name: /Split Pane Right/ })).toBeNull()
  })

  it('runs the selected command via commands.exec and closes the palette', async () => {
    useUIStore.setState({ paletteOpen: true })
    const exec = vi.spyOn(commands, 'exec').mockResolvedValue({ ok: true, result: undefined })
    render(<CommandPalette />)

    await userEvent.click(await screen.findByRole('option', { name: /Open Settings/ }))

    expect(exec).toHaveBeenCalledWith('app.openSettings')
    expect(useUIStore.getState().paletteOpen).toBe(false)
  })

  it('exposes an accessible combobox input and named option rows (a11y)', async () => {
    useUIStore.setState({ paletteOpen: true })
    render(<CommandPalette />)

    const input = await screen.findByRole('combobox')
    expect(input.tagName).toBe('INPUT')
    expect(input).toHaveAttribute('placeholder', 'Type a command…')
    expect(screen.getByRole('option', { name: /Open Settings/ })).toBeInTheDocument()
  })
})
