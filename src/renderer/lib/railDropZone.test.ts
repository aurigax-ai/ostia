import { describe, expect, it } from 'vitest'
import { rowDropZone } from './railDropZone'

describe('rowDropZone', () => {
  it('splits a row into reorder halves when the dragged workspace cannot merge into it', () => {
    expect(rowDropZone(0.1, false)).toBe('before')
    expect(rowDropZone(0.5, false)).toBe('after')
    expect(rowDropZone(0.9, false)).toBe('after')
  })

  it('keeps the edges for reordering and the middle for merging when it can merge', () => {
    expect(rowDropZone(0.1, true)).toBe('before')
    expect(rowDropZone(0.5, true)).toBe('merge')
    expect(rowDropZone(0.9, true)).toBe('after')
  })
})
