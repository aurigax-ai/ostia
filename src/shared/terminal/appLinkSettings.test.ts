import { describe, expect, it } from 'vitest'
import { appLinkAsks, parseAllowedAppSchemes, parseAskBeforeOpeningApps } from './appLinkSettings'

describe('parseAllowedAppSchemes', () => {
  it('keeps unique, lower-case app schemes', () => {
    expect(parseAllowedAppSchemes(['Obsidian', 'obsidian', 'vscode', 'chrome'])).toEqual([
      'obsidian',
      'vscode',
      'chrome',
    ])
  })

  it('drops blocked schemes, bad shapes and non-strings', () => {
    expect(
      parseAllowedAppSchemes([
        'javascript',
        'file',
        'ms-msdt',
        'devtools',
        'a',
        'x y',
        1,
        null,
        'mailto',
      ]),
    ).toEqual([])
    expect(parseAllowedAppSchemes('obsidian')).toEqual([])
  })
})

describe('appLinkAsks', () => {
  it('asks unless the question is off or the scheme is allowed', () => {
    const on = { askBeforeOpeningApps: true, allowedAppSchemes: ['vscode'] }
    expect(appLinkAsks(on, 'obsidian')).toBe(true)
    expect(appLinkAsks(on, 'vscode')).toBe(false)
    expect(appLinkAsks({ ...on, askBeforeOpeningApps: false }, 'obsidian')).toBe(false)
  })

  it('treats anything but false as on', () => {
    expect(parseAskBeforeOpeningApps(undefined)).toBe(true)
    expect(parseAskBeforeOpeningApps('no')).toBe(true)
    expect(parseAskBeforeOpeningApps(false)).toBe(false)
  })
})
