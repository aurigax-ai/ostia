import { describe, expect, it } from 'vitest'
import { lineReference, relativePath } from './fileReference'

describe('relativePath', () => {
  it('returns the path below the base', () => {
    expect(relativePath('/home/u/proj/src/a.ts', '/home/u/proj')).toBe('src/a.ts')
    expect(relativePath('/home/u/proj/src/a.ts', '/home/u/proj/')).toBe('src/a.ts')
  })

  it('returns null when the path is outside the base or is the base', () => {
    expect(relativePath('/home/u/project2/a.ts', '/home/u/proj')).toBeNull()
    expect(relativePath('/home/u/proj/', '/home/u/proj')).toBeNull()
  })
})

describe('lineReference', () => {
  it('names one line or a line span', () => {
    expect(lineReference('/a/b.ts', 3, 3)).toBe('/a/b.ts:3')
    expect(lineReference('/a/b.ts', 3, 9)).toBe('/a/b.ts:3-9')
  })
})
