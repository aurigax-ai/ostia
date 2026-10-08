import { describe, expect, it } from 'vitest'
import {
  type ArtifactEntry,
  PAD_MAX_BYTES,
  changedArtifacts,
  exceedsPad,
  isInside,
  isPadPath,
} from './artifacts'

const entry = (name: string, modified: number): ArtifactEntry => ({
  name,
  path: `/a/${name}`,
  size: 1,
  modified,
})

describe('changedArtifacts', () => {
  it('names files that are new or newer than last seen', () => {
    const before = [entry('a.md', 10), entry('b.md', 10)]
    const after = [entry('a.md', 10), entry('b.md', 11), entry('c.md', 5)]
    expect(changedArtifacts(before, after)).toEqual(['/a/b.md', '/a/c.md'])
  })

  it('names nothing when a file only went away', () => {
    expect(changedArtifacts([entry('a.md', 10), entry('b.md', 10)], [entry('a.md', 10)])).toEqual(
      [],
    )
  })
})

describe('isInside', () => {
  it('is true only below the folder', () => {
    expect(isInside('/a/w1', '/a/w1/report.md')).toBe(true)
    expect(isInside('/a/w1', '/a/w1')).toBe(false)
    expect(isInside('/a/w1', '/a/w10/report.md')).toBe(false)
    expect(isInside(null, '/a/w1/report.md')).toBe(false)
    expect(isInside('/a/w1', undefined)).toBe(false)
  })
})

describe('the pad', () => {
  it('is over its cap by bytes, not characters', () => {
    expect(exceedsPad('x'.repeat(PAD_MAX_BYTES))).toBe(false)
    expect(exceedsPad('x'.repeat(PAD_MAX_BYTES + 1))).toBe(true)
    expect(exceedsPad('字'.repeat(PAD_MAX_BYTES / 3))).toBe(false)
    expect(exceedsPad('字'.repeat(PAD_MAX_BYTES / 3 + 1))).toBe(true)
  })

  it('is one exact path of the listing', () => {
    const listing = { pad: '/a/w1/PAD.md' }
    expect(isPadPath(listing, '/a/w1/PAD.md')).toBe(true)
    expect(isPadPath(listing, '/a/w1/page/PAD.md')).toBe(false)
    expect(isPadPath(null, '/a/w1/PAD.md')).toBe(false)
  })
})
