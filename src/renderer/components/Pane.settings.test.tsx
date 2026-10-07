import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { commands } from '../commands/registry'
import type { PaneNode } from '../layout/types'
import { useSettingsStore } from '../stores/settingsStore'
import { Pane } from './Pane'

const pane: PaneNode = { type: 'pane', id: 'p9', kind: 'terminal', title: 'zsh' }

describe('Pane settings', () => {
  let settingsInit: ReturnType<typeof useSettingsStore.getState>

  beforeAll(() => {
    settingsInit = useSettingsStore.getState()
  })

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
    useSettingsStore.setState(settingsInit, true)
    document.body.innerHTML = ''
  })

  function enterPane(container: HTMLElement): void {
    container.querySelector('.pane')?.dispatchEvent(new MouseEvent('mouseenter'))
  }

  it('does not dim an inactive split pane when dimming is off', () => {
    const { container } = render(
      <Pane tabs={[pane]} shownId="p9" activePaneId="elsewhere" workspaceId="w" split />,
    )
    expect(container.querySelector('.pane')).toHaveClass('dimmed')
    act(() => useSettingsStore.getState().setPanes({ dimInactive: false }))
    expect(container.querySelector('.pane')).not.toHaveClass('dimmed')
  })

  it('removes the tab close button when hidden', () => {
    render(<Pane tabs={[pane]} shownId="p9" activePaneId={'p9'} workspaceId="w" />)
    expect(screen.getByRole('button', { name: 'Close tab' })).toBeInTheDocument()
    act(() => useSettingsStore.getState().setPanes({ hideTabClose: true }))
    expect(screen.queryByRole('button', { name: 'Close tab' })).toBeNull()
  })

  it('does nothing on hover by default', () => {
    const exec = vi.spyOn(commands, 'exec').mockResolvedValue({ ok: true, result: undefined })
    const { container } = render(
      <Pane tabs={[pane]} shownId="p9" activePaneId="elsewhere" workspaceId="w" />,
    )
    enterPane(container)
    vi.advanceTimersByTime(500)
    expect(exec).not.toHaveBeenCalled()
  })

  it('focuses an inactive pane after the pointer rests on it', () => {
    useSettingsStore.getState().setPanes({ focusOnHover: true })
    const exec = vi.spyOn(commands, 'exec').mockResolvedValue({ ok: true, result: undefined })
    const { container } = render(
      <Pane tabs={[pane]} shownId="p9" activePaneId="elsewhere" workspaceId="w" />,
    )
    enterPane(container)
    vi.advanceTimersByTime(100)
    expect(exec).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(exec).toHaveBeenCalledWith('pane.focus', { paneId: 'p9' })
  })

  it('cancels the focus when the pointer leaves early', () => {
    useSettingsStore.getState().setPanes({ focusOnHover: true })
    const exec = vi.spyOn(commands, 'exec').mockResolvedValue({ ok: true, result: undefined })
    const { container } = render(
      <Pane tabs={[pane]} shownId="p9" activePaneId="elsewhere" workspaceId="w" />,
    )
    enterPane(container)
    container.querySelector('.pane')?.dispatchEvent(new MouseEvent('mouseleave'))
    vi.advanceTimersByTime(500)
    expect(exec).not.toHaveBeenCalled()
  })

  it('never steals focus from a text field or an open dialog', () => {
    useSettingsStore.getState().setPanes({ focusOnHover: true })
    const exec = vi.spyOn(commands, 'exec').mockResolvedValue({ ok: true, result: undefined })
    const { container } = render(
      <Pane tabs={[pane]} shownId="p9" activePaneId="elsewhere" workspaceId="w" />,
    )
    const field = document.createElement('input')
    document.body.appendChild(field)
    field.focus()
    enterPane(container)
    vi.advanceTimersByTime(500)
    expect(exec).not.toHaveBeenCalled()

    field.blur()
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.appendChild(dialog)
    enterPane(container)
    vi.advanceTimersByTime(500)
    expect(exec).not.toHaveBeenCalled()
  })

  it('leaves an already active pane alone', () => {
    useSettingsStore.getState().setPanes({ focusOnHover: true })
    const exec = vi.spyOn(commands, 'exec').mockResolvedValue({ ok: true, result: undefined })
    const { container } = render(
      <Pane tabs={[pane]} shownId="p9" activePaneId={'p9'} workspaceId="w" />,
    )
    enterPane(container)
    vi.advanceTimersByTime(500)
    expect(exec).not.toHaveBeenCalled()
  })
})
