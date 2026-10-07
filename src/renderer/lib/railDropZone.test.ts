import { describe, expect, it } from 'vitest'
import { rowDropZone } from './railDropZone'

describe('rowDropZone', () => {
  it('splits a row into reorder halves when the dragged workspace cannot merge into it', () => {
    expect(rowDropZone('workspace', 0.1, false)).toBe('before')
    expect(rowDropZone('workspace', 0.5, false)).toBe('after')
    expect(rowDropZone('workspace', 0.9, false)).toBe('after')
  })

  it('keeps the edges for reordering and the middle for merging when it can merge', () => {
    expect(rowDropZone('workspace', 0.1, true)).toBe('before')
    expect(rowDropZone('workspace', 0.5, true)).toBe('merge')
    expect(rowDropZone('workspace', 0.9, true)).toBe('after')
  })

  it('gives a dragged tab the whole row when the workspace takes it, and nothing otherwise', () => {
    for (const fraction of [0.1, 0.5, 0.9]) {
      expect(rowDropZone('tab', fraction, true)).toBe('tab')
      expect(rowDropZone('tab', fraction, false)).toBeNull()
    }
  })
})
