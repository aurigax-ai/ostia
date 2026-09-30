import { describe, expect, it } from 'vitest'
import { globMatches, normalizeUrl, parseKeyCombo, scrollDelta, statusMatches } from './browseInput'

describe('parseKeyCombo', () => {
  it('maps named keys to Electron key codes', () => {
    expect(parseKeyCombo('Enter')).toEqual({ keyCode: 'Return', modifiers: [], printable: false })
    expect(parseKeyCombo('ArrowDown')?.keyCode).toBe('Down')
    expect(parseKeyCombo('Escape')?.keyCode).toBe('Escape')
  })

  it('splits modifiers off a combo like Control+a', () => {
    expect(parseKeyCombo('Control+a')).toEqual({
      keyCode: 'a',
      modifiers: ['control'],
      printable: false,
    })
    expect(parseKeyCombo('Ctrl+Shift+K')?.modifiers).toEqual(['control', 'shift'])
    expect(parseKeyCombo('Meta+Enter')?.modifiers).toEqual(['meta'])
  })

  it('marks a plain or shifted character as printable', () => {
    expect(parseKeyCombo('a')?.printable).toBe(true)
    expect(parseKeyCombo('Shift+A')?.printable).toBe(true)
  })

  it('reads the plus key itself', () => {
    expect(parseKeyCombo('+')?.keyCode).toBe('+')
    expect(parseKeyCombo('Control++')).toEqual({
      keyCode: '+',
      modifiers: ['control'],
      printable: false,
    })
  })

  it('rejects unknown modifiers and empty keys', () => {
    expect(parseKeyCombo('Hyper+a')).toBeNull()
    expect(parseKeyCombo('')).toBeNull()
    expect(parseKeyCombo('Control+')).toBeNull()
  })
})

describe('globMatches', () => {
  it('matches ** and * across path segments', () => {
    expect(globMatches('**/dashboard', 'http://localhost:3000/app/dashboard')).toBe(true)
    expect(globMatches('*', 'https://example.com/a/b?c=1')).toBe(true)
    expect(globMatches('*/api/*', 'https://x.test/api/users')).toBe(true)
  })

  it('anchors the pattern and escapes regex characters', () => {
    expect(globMatches('**/dashboard', 'http://localhost/dashboard/settings')).toBe(false)
    expect(globMatches('https://x.test/a.b', 'https://x.test/aXb')).toBe(false)
    expect(globMatches('https://x.test/?', 'https://x.test/1')).toBe(true)
  })
})

describe('scrollDelta', () => {
  it('turns a direction and distance into a signed delta', () => {
    expect(scrollDelta('down', 300)).toEqual({ dx: 0, dy: 300 })
    expect(scrollDelta('up', 50)).toEqual({ dx: 0, dy: -50 })
    expect(scrollDelta('left', 10)).toEqual({ dx: -10, dy: 0 })
    expect(scrollDelta('right', 10)).toEqual({ dx: 10, dy: 0 })
  })
})

describe('statusMatches', () => {
  it('matches an exact code, a class like 2xx, and a range', () => {
    expect(statusMatches('404', 404)).toBe(true)
    expect(statusMatches('2xx', 204)).toBe(true)
    expect(statusMatches('2xx', 301)).toBe(false)
    expect(statusMatches('400-499', 418)).toBe(true)
    expect(statusMatches('400-499', 500)).toBe(false)
  })

  it('never matches a request that has no status yet', () => {
    expect(statusMatches('2xx', undefined)).toBe(false)
  })
})

describe('normalizeUrl', () => {
  it('adds https:// when the scheme is missing', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com')
  })

  it('uses http:// for loopback hosts', () => {
    expect(normalizeUrl('localhost:3000/app')).toBe('http://localhost:3000/app')
    expect(normalizeUrl('127.0.0.1:8080')).toBe('http://127.0.0.1:8080')
  })

  it('keeps urls that already have a scheme', () => {
    expect(normalizeUrl('file:///tmp/a.html')).toBe('file:///tmp/a.html')
    expect(normalizeUrl('about:blank')).toBe('about:blank')
    expect(normalizeUrl('http://x.test')).toBe('http://x.test')
  })
})
