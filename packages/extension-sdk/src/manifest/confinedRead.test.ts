import { describe, expect, it } from 'vitest'
import { isInsideDir } from './confinedRead'

describe('isInsideDir', () => {
  it('is true only for paths strictly below the directory', () => {
    expect(isInsideDir('/a/b', 'c.html')).toBe(true)
    expect(isInsideDir('/a/b', '/a/b/c/d.html')).toBe(true)
    expect(isInsideDir('/a/b', '/a/b')).toBe(false)
    expect(isInsideDir('/a/b', '/a/bc/d.html')).toBe(false)
    expect(isInsideDir('/a/b', '../b2/x')).toBe(false)
  })
})
