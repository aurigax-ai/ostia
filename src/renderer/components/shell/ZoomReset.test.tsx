import { zoomFont } from '@/lib/app/wheelZoom'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ZOOM_CHIP_EXIT_MS, ZoomReset } from './ZoomReset'

describe('ZoomReset', () => {
  let init: ReturnType<typeof useSettingsStore.getState>

  beforeAll(() => {
    init = useSettingsStore.getState()
  })

  afterEach(() => {
    vi.useRealTimers()
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
    render(<ZoomReset />)
    act(() => zoomFont('terminal', 1))

    const button = screen.getByRole('button', { name: 'Reset zoom to 100%' })
    expect(button.textContent).toBe('110%')

    fireEvent.click(button)
    expect(useSettingsStore.getState().appearance.terminal.size).toBe(10)
    expect(screen.queryByRole('button', { name: 'Reset zoom to 100%' })).toBeNull()
  })

  it('follows the editor font too', () => {
    useSettingsStore.getState().setSurfaceFont('editor', { size: 20 })
    render(<ZoomReset />)
    act(() => zoomFont('editor', -2))
    expect(screen.getByRole('button', { name: 'Reset zoom to 100%' }).textContent).toBe('90%')
  })

  it('shows the interface zoom from the zoom commands and hides at 100%', () => {
    render(<ZoomReset />)
    act(() => useSettingsStore.getState().setZoom(110))
    const button = screen.getByRole('button', { name: 'Reset zoom to 100%' })
    expect(button.textContent).toBe('110%')

    act(() => useSettingsStore.getState().setZoom(90))
    expect(screen.getByRole('button', { name: 'Reset zoom to 100%' }).textContent).toBe('90%')

    act(() => useSettingsStore.getState().setZoom(100))
    expect(screen.queryByRole('button', { name: 'Reset zoom to 100%' })).toBeNull()
  })

  it('shows the interface zoom when the font is zoomed too, and one click clears both', () => {
    useSettingsStore.getState().setSurfaceFont('terminal', { size: 10 })
    render(<ZoomReset />)
    act(() => {
      zoomFont('terminal', 1)
      useSettingsStore.getState().setZoom(120)
    })
    const button = screen.getByRole('button', { name: 'Reset zoom to 100%' })
    expect(button.textContent).toBe('120%')

    fireEvent.click(button)
    expect(useSettingsStore.getState().appearance.zoom).toBe(100)
    expect(useSettingsStore.getState().appearance.terminal.size).toBe(10)
    expect(screen.queryByRole('button', { name: 'Reset zoom to 100%' })).toBeNull()
  })

  it('points the magnifier toward the zoom direction', () => {
    const { container } = render(<ZoomReset />)
    act(() => useSettingsStore.getState().setZoom(120))
    const zoomedIn = container.querySelector('svg')?.outerHTML
    act(() => useSettingsStore.getState().setZoom(80))
    const zoomedOut = container.querySelector('svg')?.outerHTML
    expect(zoomedIn).toBeTruthy()
    expect(zoomedOut).toBeTruthy()
    expect(zoomedIn).not.toBe(zoomedOut)
  })

  it('fades out the last value without a clickable button, then leaves nothing behind', () => {
    vi.useFakeTimers()
    const { container } = render(<ZoomReset />)
    act(() => useSettingsStore.getState().setZoom(130))
    fireEvent.click(screen.getByRole('button', { name: 'Reset zoom to 100%' }))

    expect(screen.queryByRole('button', { name: 'Reset zoom to 100%' })).toBeNull()
    const leaving = container.querySelector('[data-leaving]')
    expect(leaving?.textContent).toBe('130%')
    expect(leaving?.getAttribute('aria-hidden')).toBe('true')

    act(() => vi.advanceTimersByTime(ZOOM_CHIP_EXIT_MS))
    expect(container.innerHTML).toBe('')
  })

  it('skips the fade when motion is reduced', () => {
    useSettingsStore.getState().setMotion('reduced')
    const { container } = render(<ZoomReset />)
    act(() => useSettingsStore.getState().setZoom(110))
    fireEvent.click(screen.getByRole('button', { name: 'Reset zoom to 100%' }))
    expect(container.innerHTML).toBe('')
  })

  it('comes straight back as a button when zoomed again mid-fade', () => {
    vi.useFakeTimers()
    const { container } = render(<ZoomReset />)
    act(() => useSettingsStore.getState().setZoom(110))
    fireEvent.click(screen.getByRole('button', { name: 'Reset zoom to 100%' }))
    act(() => useSettingsStore.getState().setZoom(90))

    expect(container.querySelector('[data-leaving]')).toBeNull()
    expect(screen.getByRole('button', { name: 'Reset zoom to 100%' }).textContent).toBe('90%')
    act(() => vi.advanceTimersByTime(ZOOM_CHIP_EXIT_MS))
    expect(screen.getByRole('button', { name: 'Reset zoom to 100%' }).textContent).toBe('90%')
  })
})
