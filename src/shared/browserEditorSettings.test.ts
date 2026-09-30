import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BROWSER_SETTINGS,
  DEFAULT_EDITOR_SETTINGS,
  clampZoom,
  isValidSearchTemplate,
  parseBrowserSettings,
  parseEditorSettings,
  searchUrl,
} from './browserEditorSettings'

describe('isValidSearchTemplate', () => {
  it('accepts http and https templates containing {query}', () => {
    expect(isValidSearchTemplate('https://example.com/s?q={query}')).toBe(true)
    expect(isValidSearchTemplate('http://127.0.0.1:8080/{query}')).toBe(true)
  })

  it('rejects templates without {query}', () => {
    expect(isValidSearchTemplate('https://example.com/s?q=')).toBe(false)
  })

  it('rejects other protocols and garbage', () => {
    expect(isValidSearchTemplate('javascript:alert({query})')).toBe(false)
    expect(isValidSearchTemplate('file:///tmp/{query}')).toBe(false)
    expect(isValidSearchTemplate('{query}')).toBe(false)
  })
})

describe('searchUrl', () => {
  it('fills the chosen engine template with the encoded query', () => {
    const settings = { ...DEFAULT_BROWSER_SETTINGS, searchEngine: 'duckduckgo' as const }
    expect(searchUrl(settings, 'a b&c')).toBe('https://duckduckgo.com/?q=a%20b%26c')
  })

  it('uses the custom template when valid', () => {
    const settings = {
      ...DEFAULT_BROWSER_SETTINGS,
      searchEngine: 'custom' as const,
      customSearchUrl: 'https://s.test/?term={query}',
    }
    expect(searchUrl(settings, 'x y')).toBe('https://s.test/?term=x%20y')
  })

  it('uses Google when the custom template is invalid', () => {
    const settings = {
      ...DEFAULT_BROWSER_SETTINGS,
      searchEngine: 'custom' as const,
      customSearchUrl: 'ftp://s.test/{query}',
    }
    expect(searchUrl(settings, 'x')).toBe('https://www.google.com/search?q=x')
  })
})

describe('clampZoom', () => {
  it('keeps zoom within 50 to 300 percent', () => {
    expect(clampZoom(10)).toBe(50)
    expect(clampZoom(999)).toBe(300)
    expect(clampZoom(125.4)).toBe(125)
    expect(clampZoom(Number.NaN)).toBe(100)
  })
})

describe('parseBrowserSettings', () => {
  it('returns defaults for non-objects', () => {
    expect(parseBrowserSettings(null)).toEqual(DEFAULT_BROWSER_SETTINGS)
    expect(parseBrowserSettings([])).toEqual(DEFAULT_BROWSER_SETTINGS)
  })

  it('keeps valid values and drops invalid ones', () => {
    expect(
      parseBrowserSettings({ searchEngine: 'kagi', openTerminalLinks: true, defaultZoom: 500 }),
    ).toEqual({
      ...DEFAULT_BROWSER_SETTINGS,
      searchEngine: 'kagi',
      openTerminalLinks: true,
      defaultZoom: 300,
    })
    expect(parseBrowserSettings({ searchEngine: 'nope', openTerminalLinks: 'yes' })).toEqual(
      DEFAULT_BROWSER_SETTINGS,
    )
  })
})

describe('parseEditorSettings', () => {
  it('returns defaults for missing or invalid values', () => {
    expect(parseEditorSettings(undefined)).toEqual(DEFAULT_EDITOR_SETTINGS)
    expect(parseEditorSettings({ tabSize: 3, wordWrap: 'bounded', autoSave: 'always' })).toEqual(
      DEFAULT_EDITOR_SETTINGS,
    )
  })

  it('keeps valid values', () => {
    const custom = {
      wordWrap: 'on',
      lineNumbers: 'relative',
      tabSize: 8,
      insertSpaces: false,
      autoSave: 'afterDelay',
      formatOnSave: true,
    }
    expect(parseEditorSettings(custom)).toEqual(custom)
  })
})
