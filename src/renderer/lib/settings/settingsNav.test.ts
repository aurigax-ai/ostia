import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installLocalStorage } from '../../../../test/mocks/memoryStorage'
import {
  EXTENSIONS_NAV_EXPANDED_KEY,
  SANDBOX_NAV_EXPANDED_KEY,
  navExpanded,
  parseSettingsTarget,
  rememberNavExpanded,
} from './settingsNav'

describe('parseSettingsTarget', () => {
  it('reads an extensions/<id> section as the Extensions section anchored to that extension', () => {
    expect(parseSettingsTarget('extensions/ports')).toEqual({
      section: 'extensions',
      extension: 'ports',
    })
  })

  it('takes the extension from the options when the section has none', () => {
    expect(parseSettingsTarget('extensions', 'git')).toEqual({
      section: 'extensions',
      extension: 'git',
    })
    expect(parseSettingsTarget('appearance')).toEqual({ section: 'appearance', extension: null })
  })

  it('ignores an extension path on other sections and an empty id', () => {
    expect(parseSettingsTarget('appearance/ports')).toEqual({
      section: 'appearance',
      extension: null,
    })
    expect(parseSettingsTarget('extensions/')).toEqual({ section: 'extensions', extension: null })
  })

  it('returns no target when no section is given', () => {
    expect(parseSettingsTarget()).toEqual({ section: null, extension: null })
  })
})

describe('navExpanded', () => {
  beforeEach(() => installLocalStorage())
  afterEach(() => {
    window.localStorage.removeItem(EXTENSIONS_NAV_EXPANDED_KEY)
    window.localStorage.removeItem(SANDBOX_NAV_EXPANDED_KEY)
  })

  it('is collapsed until the human expands it, and remembers the choice', () => {
    expect(navExpanded(EXTENSIONS_NAV_EXPANDED_KEY)).toBe(false)
    rememberNavExpanded(EXTENSIONS_NAV_EXPANDED_KEY, true)
    expect(navExpanded(EXTENSIONS_NAV_EXPANDED_KEY)).toBe(true)
    rememberNavExpanded(EXTENSIONS_NAV_EXPANDED_KEY, false)
    expect(navExpanded(EXTENSIONS_NAV_EXPANDED_KEY)).toBe(false)
  })

  it('remembers each nested list on its own', () => {
    rememberNavExpanded(SANDBOX_NAV_EXPANDED_KEY, true)
    expect(navExpanded(SANDBOX_NAV_EXPANDED_KEY)).toBe(true)
    expect(navExpanded(EXTENSIONS_NAV_EXPANDED_KEY)).toBe(false)
  })
})
