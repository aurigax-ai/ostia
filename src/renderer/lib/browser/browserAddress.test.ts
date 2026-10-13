import { DEFAULT_BROWSER_SETTINGS } from '@shared/browser/browserEditorSettings'
import { describe, expect, it } from 'vitest'
import { resolveAddress } from './browserAddress'

const settings = DEFAULT_BROWSER_SETTINGS

describe('resolveAddress', () => {
  it('opens a blank page for empty input', () => {
    expect(resolveAddress('  ', settings)).toBe('about:blank')
  })

  it('keeps input that already has a scheme', () => {
    expect(resolveAddress('http://127.0.0.1:3000/x', settings)).toBe('http://127.0.0.1:3000/x')
  })

  it('adds https to a bare host', () => {
    expect(resolveAddress('example.com/a', settings)).toBe('https://example.com/a')
  })

  it('searches with the chosen engine when the text is not a URL', () => {
    expect(resolveAddress('ostia terminal', { ...settings, searchEngine: 'bing' })).toBe(
      'https://www.bing.com/search?q=ostia%20terminal',
    )
  })

  it('searches with a custom template', () => {
    const custom = {
      ...settings,
      searchEngine: 'custom' as const,
      customSearchUrl: 'http://127.0.0.1:9/find?term={query}',
    }
    expect(resolveAddress('hello world', custom)).toBe('http://127.0.0.1:9/find?term=hello%20world')
  })
})
