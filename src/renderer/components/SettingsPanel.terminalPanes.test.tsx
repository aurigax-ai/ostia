import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
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
})
