import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { PauseTerminal } from './ostiaTerminal'
import { usePauseWhenHidden } from './usePauseWhenHidden'

function fakePause(): { pause: PauseTerminal; setPaused: ReturnType<typeof vi.fn> } {
  const setPaused = vi.fn()
  return { pause: setPaused, setPaused }
}

function mount(
  shown: boolean,
  pauseRef = { current: fakePause().pause },
  syncSizeRef = { current: vi.fn() },
) {
  return renderHook(
    ({ shown, paneId }) => usePauseWhenHidden(pauseRef, syncSizeRef, shown, paneId),
    { initialProps: { shown, paneId: 'p1' } },
  )
}

describe('usePauseWhenHidden', () => {
  it('leaves a shown terminal drawing', () => {
    const { pause, setPaused } = fakePause()
    mount(true, { current: pause })
    expect(setPaused.mock.calls).toEqual([[false]])
  })

  it('pauses a hidden terminal and resumes it when shown again', () => {
    const { pause, setPaused } = fakePause()
    const view = mount(true, { current: pause })
    view.rerender({ shown: false, paneId: 'p1' })
    view.rerender({ shown: true, paneId: 'p1' })
    expect(setPaused.mock.calls).toEqual([[false], [true], [false]])
  })

  it('fits a terminal as it is shown and leaves a hidden one alone', () => {
    const syncSize = vi.fn()
    const view = mount(false, { current: fakePause().pause }, { current: syncSize })
    expect(syncSize).not.toHaveBeenCalled()
    view.rerender({ shown: true, paneId: 'p1' })
    expect(syncSize).toHaveBeenCalledTimes(1)
    view.rerender({ shown: false, paneId: 'p1' })
    expect(syncSize).toHaveBeenCalledTimes(1)
  })

  it('pauses the new terminal when a hidden pane creates one', () => {
    const first = fakePause()
    const second = fakePause()
    const pauseRef = { current: first.pause }
    const view = mount(false, pauseRef)
    pauseRef.current = second.pause
    view.rerender({ shown: false, paneId: 'p2' })
    expect(second.setPaused.mock.calls).toEqual([[true]])
  })
})
