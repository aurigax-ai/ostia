import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installLocalStorage } from '../../../test/mocks/memoryStorage'
import {
  PLUGINS_NAV_EXPANDED_KEY,
  parseSettingsTarget,
  pluginsNavExpanded,
  rememberPluginsNavExpanded,
} from './settingsNav'

describe('parseSettingsTarget', () => {
  it('reads a plugins/<id> section as the Plugins section anchored to that extension', () => {
    expect(parseSettingsTarget('plugins/ports')).toEqual({ section: 'plugins', extension: 'ports' })
  })

  it('takes the extension from the options when the section has none', () => {
    expect(parseSettingsTarget('plugins', 'git')).toEqual({ section: 'plugins', extension: 'git' })
    expect(parseSettingsTarget('appearance')).toEqual({ section: 'appearance', extension: null })
  })

  it('ignores an extension path on other sections and an empty id', () => {
    expect(parseSettingsTarget('appearance/ports')).toEqual({
      section: 'appearance',
      extension: null,
    })
    expect(parseSettingsTarget('plugins/')).toEqual({ section: 'plugins', extension: null })
  })

  it('returns no target when no section is given', () => {
    expect(parseSettingsTarget()).toEqual({ section: null, extension: null })
  })
})

describe('pluginsNavExpanded', () => {
  beforeEach(() => installLocalStorage())
  afterEach(() => window.localStorage.removeItem(PLUGINS_NAV_EXPANDED_KEY))

  it('is collapsed until the human expands it, and remembers the choice', () => {
    expect(pluginsNavExpanded()).toBe(false)
    rememberPluginsNavExpanded(true)
    expect(pluginsNavExpanded()).toBe(true)
    rememberPluginsNavExpanded(false)
    expect(pluginsNavExpanded()).toBe(false)
  })
})
