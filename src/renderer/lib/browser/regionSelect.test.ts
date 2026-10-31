import { describe, expect, it } from 'vitest'
import { dragRegion } from './regionSelect'

describe('dragRegion', () => {
  const bounds = { width: 200, height: 100 }

  it('normalizes a drag in any direction into a whole-pixel region', () => {
    expect(dragRegion({ x: 120.6, y: 80.2 }, { x: 20.4, y: 10.9 }, bounds)).toEqual({
      x: 20,
      y: 10,
      width: 101,
      height: 71,
    })
  })

  it('clamps a drag that leaves the content to its edges', () => {
    expect(dragRegion({ x: -30, y: -5 }, { x: 500, y: 40 }, bounds)).toEqual({
      x: 0,
      y: 0,
      width: 200,
      height: 40,
    })
  })

  it('returns null for a click or a sliver', () => {
    expect(dragRegion({ x: 10, y: 10 }, { x: 10, y: 10 }, bounds)).toBeNull()
    expect(dragRegion({ x: 10, y: 10 }, { x: 60, y: 11 }, bounds)).toBeNull()
  })

  it('returns null when the whole drag is outside the content', () => {
    expect(dragRegion({ x: 300, y: 10 }, { x: 400, y: 50 }, bounds)).toBeNull()
  })
})
