import { describe, expect, it } from 'vitest'
import { OPEN_FILES_MAX, openTargetKind, parseFileTargets } from './openFiles'

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

describe('openTargetKind', () => {
  it('takes a word for a URL only when it starts with http:// or https://', () => {
    expect(openTargetKind('https://example.com/a')).toBe('url')
    expect(openTargetKind('HTTP://127.0.0.1:3000')).toBe('url')
    for (const word of [
      'example.com',
      'localhost:3000',
      'www.example.com/a',
      'ftp://x/',
      'http:',
    ]) {
      expect(openTargetKind(word), word).toBe('path')
    }
  })

  it('reads a lone dash as stdin and nothing else', () => {
    expect(openTargetKind('-')).toBe('stdin')
    expect(openTargetKind('--')).toBe('path')
    expect(openTargetKind('-x')).toBe('path')
  })
})
