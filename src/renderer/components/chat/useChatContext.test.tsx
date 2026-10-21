import { act, cleanup, renderHook } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { useDict } from '@/lib/app/useDict'
import { useLiveSelectionStore } from '@/stores/terminal/liveSelectionStore'
import { useChatContext } from './useChatContext'

const range = { kind: 'editor', file: '/home/u/proj/src/a.ts', startLine: 2, endLine: 4 } as const

function committedStates() {
  const states: { selected: boolean; on: boolean }[] = []
  renderHook(() => {
    const context = useChatContext({ workspaceId: 'w1', labels: useDict().ask.context })
    const selected = context.selectedText !== undefined
    const on = context.enabled.has('selection')
    useEffect(() => {
      states.push({ selected, on })
    })
  })
  return { states }
}

afterEach(() => {
  cleanup()
  useLiveSelectionStore.setState(useLiveSelectionStore.getInitialState(), true)
})

describe('useChatContext', () => {
  it('commits the selection chip pressed when text is already selected on mount', () => {
    useLiveSelectionStore.getState().report('w1', 'p-editor', range, 'two\nthree')
    const { states } = committedStates()
    expect(states).toEqual([{ selected: true, on: true }])
  })

  it('commits the selection chip pressed in the render that a new selection arrives', () => {
    const { states } = committedStates()
    act(() => useLiveSelectionStore.getState().report('w1', 'p-editor', range, 'two\nthree'))
    expect(states).toEqual([
      { selected: false, on: false },
      { selected: true, on: true },
    ])
  })
})
