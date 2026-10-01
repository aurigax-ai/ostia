import { describe, expect, it } from 'vitest'
import { OPEN_FILES_MAX, parseFileTargets } from './openFiles'

describe('parseFileTargets', () => {
  it('keeps a path with a positive line and column', () => {
    expect(parseFileTargets([{ path: '/a.ts', line: 3, column: 2 }, { path: '/b.png' }])).toEqual([
      { path: '/a.ts', line: 3, column: 2 },
      { path: '/b.png' },
    ])
  })

  it('drops a position that is not a positive whole number, and a column without a line', () => {
    expect(parseFileTargets([{ path: '/a.ts', line: 0, column: 4 }])).toEqual([{ path: '/a.ts' }])
    expect(parseFileTargets([{ path: '/a.ts', line: '3' }])).toEqual([{ path: '/a.ts' }])
    expect(parseFileTargets([{ path: '/a.ts', line: 2, column: 1.5 }])).toEqual([
      { path: '/a.ts', line: 2 },
    ])
  })

  it('refuses anything but a short list of paths', () => {
    expect(parseFileTargets(undefined)).toBeNull()
    expect(parseFileTargets([])).toBeNull()
    expect(parseFileTargets(['/a.ts'])).toBeNull()
    expect(parseFileTargets([{ path: '' }])).toBeNull()
    expect(parseFileTargets([{ path: 7 }])).toBeNull()
    const many = Array.from({ length: OPEN_FILES_MAX + 1 }, (_, i) => ({ path: `/f${i}` }))
    expect(parseFileTargets(many)).toBeNull()
  })
})
