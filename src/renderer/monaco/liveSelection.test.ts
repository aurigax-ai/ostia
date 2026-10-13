import { useLiveSelectionStore } from '@/stores/terminal/liveSelectionStore'
import { renderHook } from '@testing-library/react'
import type * as monaco from 'monaco-editor'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LIVE_SELECTION_DELAY_MS, useLiveEditorSelection } from './liveSelection'

interface Range {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}

function fakeEditor() {
  let selection: Range = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }
  const listeners = new Set<() => void>()
  const editor = {
    getSelection: () => selection,
    getModel: () => ({
      getValueInRange: (range: Range) => `lines ${range.startLineNumber}-${range.endLineNumber}`,
    }),
    onDidChangeCursorSelection: (listener: () => void) => {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
  }
  return {
    editor: editor as unknown as monaco.editor.IStandaloneCodeEditor,
    listeners,
    select(next: Range): void {
      selection = next
      for (const listener of listeners) listener()
    },
  }
}

function mount(fake: ReturnType<typeof fakeEditor>) {
  return renderHook(() =>
    useLiveEditorSelection({ current: fake.editor }, { current: '/proj/a.ts' }, 'w1', 'p1'),
  )
}

describe('useLiveEditorSelection', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    useLiveSelectionStore.setState({ byWorkspace: {} })
  })

  it('reports only the last selection, once the cursor has rested for the delay', () => {
    const fake = fakeEditor()
    mount(fake)
    fake.select({ startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 4 })
    vi.advanceTimersByTime(LIVE_SELECTION_DELAY_MS - 1)
    fake.select({ startLineNumber: 3, startColumn: 1, endLineNumber: 5, endColumn: 1 })
    vi.advanceTimersByTime(LIVE_SELECTION_DELAY_MS - 1)
    expect(useLiveSelectionStore.getState().byWorkspace).toEqual({})

    vi.advanceTimersByTime(1)
    expect(useLiveSelectionStore.getState().byWorkspace).toEqual({
      w1: {
        paneId: 'p1',
        source: { kind: 'editor', file: '/proj/a.ts', startLine: 3, endLine: 4 },
        text: 'lines 3-5',
      },
    })
  })

  it('clears the report when the selection collapses to a cursor', () => {
    const fake = fakeEditor()
    mount(fake)
    fake.select({ startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 4 })
    vi.advanceTimersByTime(LIVE_SELECTION_DELAY_MS)
    expect(useLiveSelectionStore.getState().byWorkspace.w1?.paneId).toBe('p1')

    fake.select({ startLineNumber: 2, startColumn: 4, endLineNumber: 2, endColumn: 4 })
    vi.advanceTimersByTime(LIVE_SELECTION_DELAY_MS)
    expect(useLiveSelectionStore.getState().byWorkspace).toEqual({})
  })

  it('drops a pending report and stops listening when the editor unmounts', () => {
    const fake = fakeEditor()
    const { unmount } = mount(fake)
    fake.select({ startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 4 })
    unmount()
    vi.advanceTimersByTime(LIVE_SELECTION_DELAY_MS)
    expect(useLiveSelectionStore.getState().byWorkspace).toEqual({})
    expect(fake.listeners.size).toBe(0)
  })
})
