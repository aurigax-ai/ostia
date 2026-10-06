import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { zoomFont } from '../lib/wheelZoom'
import { useSettingsStore } from '../stores/settingsStore'
import { ZoomReset } from './ZoomReset'

describe('ZoomReset', () => {
  let init: ReturnType<typeof useSettingsStore.getState>

  beforeAll(() => {
    init = useSettingsStore.getState()
  })

  afterEach(() => {
    cleanup()
    useSettingsStore.setState(init, true)
  })

  it('shows nothing at the normal size, even with a custom font size', () => {
    useSettingsStore.getState().setSurfaceFont('terminal', { size: 17 })
    const { container } = render(<ZoomReset />)
    expect(container.innerHTML).toBe('')
  })

  it('shows the scale once the font is zoomed and goes back to 100% on click', () => {
    useSettingsStore.getState().setSurfaceFont('terminal', { size: 10 })
    useSettingsStore.getState().setZoom(120)
    render(<ZoomReset />)
    act(() => zoomFont('terminal', 1))

    const button = screen.getByRole('button', { name: 'Reset zoom to 100%' })
    expect(button.textContent).toBe('110%')

    fireEvent.click(button)
    expect(useSettingsStore.getState().appearance.terminal.size).toBe(10)
    expect(useSettingsStore.getState().appearance.zoom).toBe(100)
    expect(screen.queryByRole('button', { name: 'Reset zoom to 100%' })).toBeNull()
  })

  it('follows the editor font too', () => {
    useSettingsStore.getState().setSurfaceFont('editor', { size: 20 })
    render(<ZoomReset />)
    act(() => zoomFont('editor', -2))
    expect(screen.getByRole('button', { name: 'Reset zoom to 100%' }).textContent).toBe('90%')
  })
})
