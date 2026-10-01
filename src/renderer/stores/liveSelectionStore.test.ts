import { afterEach, describe, expect, it } from 'vitest'
import { liveSelectionContext, selectionRef } from '../lib/askContext'
import { useLiveSelectionStore } from './liveSelectionStore'

const editorAt = (file: string, startLine: number, endLine: number) =>
  ({ kind: 'editor', file, startLine, endLine }) as const

afterEach(() => {
  useLiveSelectionStore.setState({ byWorkspace: {} })
})

describe('liveSelectionStore', () => {
  it('keeps the latest selection of each workspace and drops it when its pane clears', () => {
    const { report, clear } = useLiveSelectionStore.getState()

    report('w1', 'p1', editorAt('/w/a.ts', 2, 4), 'two\nthree\nfour')
    report('w2', 'p2', { kind: 'terminal' }, 'ls -la')
    expect(useLiveSelectionStore.getState().byWorkspace.w1?.text).toBe('two\nthree\nfour')
    expect(useLiveSelectionStore.getState().byWorkspace.w2?.source.kind).toBe('terminal')

    report('w1', 'p1', editorAt('/w/a.ts', 2, 2), '   ')
    expect(useLiveSelectionStore.getState().byWorkspace.w1).toBeUndefined()
    clear('p2')
    expect(useLiveSelectionStore.getState().byWorkspace).toEqual({})
  })
})

describe('liveSelectionContext', () => {
  it('names the file and lines of an editor selection, and only the label for a terminal one', () => {
    const { report } = useLiveSelectionStore.getState()
    report('w1', 'p1', editorAt('/w/src/a.ts', 2, 4), 'two\nthree\nfour')
    report('w2', 'p2', { kind: 'terminal' }, 'ls -la')

    expect(liveSelectionContext('w1', 'Selection')).toEqual({
      kind: 'selection',
      label: 'Selection a.ts:2-4',
      text: 'two\nthree\nfour',
    })
    expect(liveSelectionContext('w2', 'Selection')).toEqual({
      kind: 'selection',
      label: 'Selection',
      text: 'ls -la',
    })
    expect(liveSelectionContext('w3', 'Selection')).toBeNull()
    expect(selectionRef({ paneId: 'p1', source: editorAt('/w/a.ts', 7, 7), text: 'x' })).toBe(
      'a.ts:7',
    )
  })
})
