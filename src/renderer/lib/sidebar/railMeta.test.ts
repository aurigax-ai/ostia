import { describe, expect, it } from 'vitest'
import { fitCount, pathCandidates, shortenPath } from './railMeta'

describe('pathCandidates', () => {
  it('drops middle segments one at a time and keeps the last segment', () => {
    expect(pathCandidates('~/Personal/goji/avail')).toEqual([
      '~/Personal/goji/avail',
      '~/…/goji/avail',
      '~/…/avail',
      'avail',
    ])
  })

  it('keeps the root of an absolute path', () => {
    expect(pathCandidates('/srv/www/app')).toEqual(['/srv/www/app', '/…/www/app', '/…/app', 'app'])
  })

  it('offers only shorter forms than the full path', () => {
    expect(pathCandidates('~/a/b')).toEqual(['~/a/b', 'b'])
    expect(pathCandidates('~')).toEqual(['~'])
    expect(pathCandidates('/')).toEqual(['/'])
  })
})

describe('shortenPath', () => {
  const path = '~/Personal/goji/avail'

  it('returns the full path when it fits', () => {
    expect(shortenPath(path, 40)).toBe(path)
    expect(shortenPath(path, path.length)).toBe(path)
  })

  it('ellipsizes from the middle, never to a bare head', () => {
    expect(shortenPath(path, 16)).toBe('~/…/goji/avail')
    expect(shortenPath(path, 10)).toBe('~/…/avail')
    expect(shortenPath(path, 6)).toBe('avail')
  })

  it('falls back to the last segment when nothing fits', () => {
    expect(shortenPath(path, 0)).toBe('avail')
  })
})

describe('fitCount', () => {
  it('shows every item when they all fit', () => {
    expect(fitCount({ widths: [40, 40], available: 88, gap: 8, moreWidth: 20 })).toBe(2)
  })

  it('leaves room for the more button when items overflow', () => {
    const widths = [40, 40, 40, 40, 40, 40]
    expect(fitCount({ widths, available: 160, gap: 8, moreWidth: 20 })).toBe(2)
    expect(fitCount({ widths, available: 188, gap: 8, moreWidth: 20 })).toBe(3)
  })

  it('always keeps the first item, which then truncates', () => {
    expect(fitCount({ widths: [200, 40], available: 100, gap: 8, moreWidth: 20 })).toBe(1)
    expect(fitCount({ widths: [200], available: 100, gap: 8, moreWidth: 20 })).toBe(1)
  })

  it('shows nothing for no items', () => {
    expect(fitCount({ widths: [], available: 100, gap: 8, moreWidth: 20 })).toBe(0)
  })
})
