import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { PauseTerminal } from './ostiaTerminal'
import { usePauseWhenHidden } from './usePauseWhenHidden'

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
