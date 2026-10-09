import { describe, expect, it } from 'vitest'
import { WatchSets } from './watchSets'

describe('WatchSets', () => {
  it('is empty until a window names a workspace, and again once every window stopped', () => {
    const sets = new WatchSets()
    expect(sets.empty).toBe(true)
    expect(sets.set('w1', ['a', 'b'])).toBe(true)
    expect(sets.set('w2', ['b', 'c'])).toBe(true)
    expect([...sets.union()].sort()).toEqual(['a', 'b', 'c'])
    expect(sets.set('w1', [])).toBe(true)
    expect(sets.drop('w2')).toBe(true)
    expect(sets.empty).toBe(true)
  })

  it('reports no change for the same set in another order', () => {
    const sets = new WatchSets()
    sets.set('w1', ['a', 'b'])
    expect(sets.set('w1', ['b', 'a'])).toBe(false)
  })

  it('keeps only non-empty strings from what a window sent', () => {
    const sets = new WatchSets()
    sets.set('w1', ['a', '', 3, null, { id: 'x' }])
    expect([...sets.union()]).toEqual(['a'])
    expect(sets.set('w1', 'a')).toBe(true)
    expect(sets.empty).toBe(true)
  })
})
