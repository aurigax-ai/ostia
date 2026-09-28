import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { useEditorStatus } from './editorStatusStore'

describe('editorStatusStore', () => {
  let init: ReturnType<typeof useEditorStatus.getState>
  beforeAll(() => {
    init = useEditorStatus.getState()
  })
  afterEach(() => useEditorStatus.setState(init, true))

  it('marks and clears a file as dirty', () => {
    useEditorStatus.getState().setDirty('/a.ts', true)
    expect(useEditorStatus.getState().dirty['/a.ts']).toBe(true)
    useEditorStatus.getState().setDirty('/a.ts', false)
    expect('/a.ts' in useEditorStatus.getState().dirty).toBe(false)
  })

  it('keeps the same state object when the flag does not change', () => {
    useEditorStatus.getState().setDirty('/a.ts', true)
    const before = useEditorStatus.getState()
    useEditorStatus.getState().setDirty('/a.ts', true)
    expect(useEditorStatus.getState()).toBe(before)
  })
})
