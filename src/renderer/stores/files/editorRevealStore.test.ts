import { afterEach, describe, expect, it } from 'vitest'
import { useEditorRevealStore } from './editorRevealStore'

describe('editorRevealStore', () => {
  afterEach(() => useEditorRevealStore.setState({ pending: {} }))

  it('hands a requested position to the editor once', () => {
    useEditorRevealStore.getState().request('/p/a.ts', { line: 3, column: 2 })
    expect(useEditorRevealStore.getState().take('/p/a.ts')).toEqual({ line: 3, column: 2 })
    expect(useEditorRevealStore.getState().take('/p/a.ts')).toBeUndefined()
  })
})
