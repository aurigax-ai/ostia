import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PauseTerminal } from './ostiaTerminal'
import { RELEASE_RENDERER_MS, usePauseWhenHidden } from './usePauseWhenHidden'

function fakePause(): { pause: PauseTerminal; setPaused: ReturnType<typeof vi.fn> } {
  const setPaused = vi.fn()
  return { pause: setPaused, setPaused }
}

function mount(shown: boolean, pauseRef = { current: fakePause().pause }) {
  return renderHook(({ shown, paneId }) => usePauseWhenHidden(pauseRef, shown, paneId, 'ghostty'), {
    initialProps: { shown, paneId: 'p1' },
  })
}

describe('usePauseWhenHidden', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('leaves a shown terminal drawing', () => {
    const { pause, setPaused } = fakePause()
    mount(true, { current: pause })
    expect(setPaused.mock.calls).toEqual([[false]])
  })

  it('pauses a hidden terminal at once and releases its renderer only after the delay', () => {
    vi.useFakeTimers()
    const { pause, setPaused } = fakePause()
    mount(false, { current: pause })
    expect(setPaused.mock.calls).toEqual([[true]])

    vi.advanceTimersByTime(RELEASE_RENDERER_MS - 1)
    expect(setPaused).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(setPaused.mock.calls).toEqual([[true], [true, { releaseRenderer: true }]])
  })

  it('resumes when shown again and keeps the renderer of a briefly hidden terminal', () => {
    vi.useFakeTimers()
    const { pause, setPaused } = fakePause()
    const view = mount(true, { current: pause })
    view.rerender({ shown: false, paneId: 'p1' })
    vi.advanceTimersByTime(RELEASE_RENDERER_MS / 2)
    view.rerender({ shown: true, paneId: 'p1' })
    vi.advanceTimersByTime(RELEASE_RENDERER_MS)

    expect(setPaused.mock.calls).toEqual([[false], [true], [false]])
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

  it('stops the pending release when the pane unmounts', () => {
    vi.useFakeTimers()
    const { pause, setPaused } = fakePause()
    const view = mount(false, { current: pause })
    view.unmount()
    vi.advanceTimersByTime(RELEASE_RENDERER_MS)
    expect(setPaused).toHaveBeenCalledTimes(1)
  })
})
