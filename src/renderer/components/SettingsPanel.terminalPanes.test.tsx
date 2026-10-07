import '@testing-library/jest-dom/vitest'
import { KEEP_SHELLS_FEATURE } from '@shared/keepShells'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { SettingsPanel } from './SettingsPanel'

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

describe('SettingsPanel terminal and pane rows', () => {
  let settingsInit: ReturnType<typeof useSettingsStore.getState>
  let uiInit: ReturnType<typeof useUIStore.getState>

  beforeAll(() => {
    settingsInit = useSettingsStore.getState()
    uiInit = useUIStore.getState()
  })

  afterEach(() => {
    cleanup()
    useSettingsStore.setState(settingsInit, true)
    useUIStore.setState(uiInit, true)
  })

  async function openSection(name: string) {
    useUIStore.setState({ settingsActive: true, settingsTabOpen: true })
    render(<SettingsPanel />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name }))
    return user
  }

  it('shows the terminal defaults', async () => {
    await openSection('Terminal')
    expect(screen.getByRole('spinbutton', { name: 'Scroll speed' })).toHaveValue(1)
    expect(screen.getByRole('spinbutton', { name: 'Scrollback lines' })).toHaveValue(10000)
    expect(screen.getByRole('spinbutton', { name: 'Minimum contrast ratio' })).toHaveValue(1)
    expect(screen.getByRole('switch', { name: 'Confirm multi-line paste' })).toBeChecked()
  })

  it('stores in-range numbers and ignores out-of-range ones', async () => {
    await openSection('Terminal')
    const lines = screen.getByRole('spinbutton', { name: 'Scrollback lines' })
    fireEvent.change(lines, { target: { value: '25000' } })
    expect(useSettingsStore.getState().terminal.scrollbackLines).toBe(25000)
    fireEvent.change(lines, { target: { value: '5' } })
    expect(useSettingsStore.getState().terminal.scrollbackLines).toBe(25000)
    fireEvent.blur(lines)
    expect(lines).toHaveValue(25000)

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Scroll speed' }), {
      target: { value: '2.5' },
    })
    expect(useSettingsStore.getState().terminal.scrollSpeed).toBe(2.5)
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Minimum contrast ratio' }), {
      target: { value: '4.5' },
    })
    expect(useSettingsStore.getState().terminal.minimumContrast).toBe(4.5)
  })

  it('toggles the multi-line paste confirmation', async () => {
    const user = await openSection('Terminal')
    await user.click(screen.getByRole('switch', { name: 'Confirm multi-line paste' }))
    expect(useSettingsStore.getState().terminal.warnOnRiskyPaste).toBe(false)
  })

  it('lists the Panes page with its four switches and their defaults', async () => {
    const user = await openSection('Panes')
    expect(screen.getByRole('heading', { level: 2, name: 'Panes' })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Dim inactive panes' })).toBeChecked()
    expect(screen.getByRole('switch', { name: 'Focus pane on hover' })).not.toBeChecked()
    expect(screen.getByRole('switch', { name: 'Equalize splits on create' })).not.toBeChecked()
    expect(screen.getByRole('switch', { name: 'Hide tab close buttons' })).not.toBeChecked()

    await user.click(screen.getByRole('switch', { name: 'Focus pane on hover' }))
    await user.click(screen.getByRole('switch', { name: 'Dim inactive panes' }))
    expect(useSettingsStore.getState().panes.focusOnHover).toBe(true)
    expect(useSettingsStore.getState().panes.dimInactive).toBe(false)
  })

  function tmuxReport(
    missing: { program: string; package: string; needs?: string; found?: string }[],
  ) {
    window.ostia.system.requirements = vi.fn(async (feature: string) => ({
      missing: feature === KEEP_SHELLS_FEATURE ? missing : [],
      hint: { command: 'sudo pacman -S --needed tmux', packages: ['tmux'] },
      canInstall: false,
    }))
  }

  it('KSH-C17 turns keeping shells on when tmux is ready', async () => {
    tmuxReport([])
    const user = await openSection('Terminal')
    const keep = screen.getByRole('switch', { name: 'Keep shells running across a restart' })
    await waitFor(() => expect(keep).not.toHaveAttribute('aria-disabled', 'true'))
    await user.click(keep)
    expect(useSettingsStore.getState().terminal.keepShells).toBe(true)
  })

  it('KSH-C18 keeps the switch off and offers the install while tmux is missing', async () => {
    tmuxReport([{ program: 'tmux', package: 'tmux' }])
    const user = await openSection('Terminal')
    expect(await screen.findByText('sudo pacman -S --needed tmux')).toBeInTheDocument()
    const keep = screen.getByRole('switch', { name: 'Keep shells running across a restart' })
    expect(keep).toHaveAttribute('aria-disabled', 'true')
    await user.click(keep)
    expect(useSettingsStore.getState().terminal.keepShells).toBe(false)
  })

  it('KSH-C19 names the tmux version needed when the installed one is too old', async () => {
    tmuxReport([{ program: 'tmux', package: 'tmux', needs: '3.2', found: '3.1' }])
    await openSection('Terminal')
    expect(await screen.findByText(/tmux 3\.2 or newer/)).toBeInTheDocument()
    expect(screen.getByText('Found tmux 3.1.')).toBeInTheDocument()
    expect(
      screen.getByRole('switch', { name: 'Keep shells running across a restart' }),
    ).toHaveAttribute('aria-disabled', 'true')
  })

  function rowOf(label: string): HTMLElement {
    const row = screen.getByText(label).closest<HTMLElement>('[data-settings-row]')
    if (!row) throw new Error(`no row for ${label}`)
    return row
  }

  it('marks the terminal engine and keeping shells as experimental', async () => {
    tmuxReport([])
    await openSection('Terminal')
    expect(within(rowOf('Terminal engine')).getByText('Experimental')).toBeVisible()
    expect(
      within(rowOf('Keep shells running across a restart')).getByText('Experimental'),
    ).toBeVisible()
    expect(within(rowOf('Scroll speed')).queryByText('Experimental')).toBeNull()
  })

  it('switches the terminal engine to Ghostty', async () => {
    const user = await openSection('Terminal')
    await user.click(screen.getByRole('combobox', { name: 'Terminal engine' }))
    await user.click(await screen.findByRole('option', { name: 'Ghostty' }))
    expect(useSettingsStore.getState().terminal.renderer).toBe('ghostty')
  })

  it('KSH-C18 lets the switch turn on once a re-check finds tmux, without reopening Settings', async () => {
    tmuxReport([{ program: 'tmux', package: 'tmux' }])
    const user = await openSection('Terminal')
    expect(await screen.findByText('tmux is not installed.')).toBeInTheDocument()
    tmuxReport([])
    fireEvent(window, new Event('focus'))
    await waitFor(() => expect(screen.queryByText('tmux is not installed.')).toBeNull())
    const keep = screen.getByRole('switch', { name: 'Keep shells running across a restart' })
    await waitFor(() => expect(keep).not.toHaveAttribute('aria-disabled', 'true'))
    await user.click(keep)
    expect(useSettingsStore.getState().terminal.keepShells).toBe(true)
  })
})
