import type { ExtensionInfo, ExtensionSettingContribution } from '@shared/extensions'
import { PRODUCT_DISPLAY_NAME } from '@shared/productDisplay'
import { describe, expect, it } from 'vitest'
import {
  entryTitle,
  enumValueTitle,
  extensionMatchesQuery,
  humanizeSettingKey,
} from './extensionSettingText'

function setting(overrides: Partial<ExtensionSettingContribution> = {}) {
  return {
    key: 'intervalSeconds',
    type: 'number',
    default: 3,
    description: 'd',
    ...overrides,
  } as ExtensionSettingContribution
}

function ext(overrides: Partial<ExtensionInfo> = {}): ExtensionInfo {
  return {
    id: 'ports',
    name: 'Ports',
    version: '1.0.0',
    description: '',
    builtin: true,
    enabled: true,
    status: 'running',
    requested: [],
    granted: [],
    unapproved: [],
    commands: [],
    panel: null,
    paneChips: [],
    workspaceChips: [],
    settings: [setting({ title: 'Scan interval' })],
    settingValues: {},
    assist: [],
    secrets: [{ key: 'apiKey', title: 'API key', description: 'k' }],
    secretsSet: [],
    settingsPage: null,
    category: 'other',
    languages: [],
    languageServers: [],
    agentSkills: [],
    agentHooks: [],
    iconThemes: [],
    ...overrides,
  }
}

describe('humanizeSettingKey', () => {
  it('turns camelCase into sentence case', () => {
    expect(humanizeSettingKey('intervalSeconds')).toBe('Interval seconds')
    expect(humanizeSettingKey('portHost')).toBe('Port host')
    expect(humanizeSettingKey('notify')).toBe('Notify')
  })

  it('splits snake_case and kebab-case keys', () => {
    expect(humanizeSettingKey('idle_poll_seconds')).toBe('Idle poll seconds')
    expect(humanizeSettingKey('show-diff-stats')).toBe('Show diff stats')
  })

  it('keeps acronyms written in capitals', () => {
    expect(humanizeSettingKey('baseURL')).toBe('Base URL')
    expect(humanizeSettingKey('HTTPProxyHost')).toBe('HTTP proxy host')
  })

  it('keeps digits with the word they follow', () => {
    expect(humanizeSettingKey('retry2Count')).toBe('Retry2 count')
  })
})

describe('entryTitle', () => {
  it('prefers the manifest title and falls back to the humanized key', () => {
    expect(entryTitle(setting({ title: 'Scan interval' }))).toBe('Scan interval')
    expect(entryTitle(setting())).toBe('Interval seconds')
  })

  it('substitutes the product name in a title', () => {
    expect(entryTitle(setting({ title: '{product} focus' }))).toBe(`${PRODUCT_DISPLAY_NAME} focus`)
  })
})

describe('enumValueTitle', () => {
  it('shows the value title when the manifest gives one, else the raw value', () => {
    const scope = setting({
      type: 'enum',
      values: ['current', 'all'],
      valueTitles: { current: 'Current branch' },
      default: 'current',
    })
    expect(enumValueTitle(scope, 'current')).toBe('Current branch')
    expect(enumValueTitle(scope, 'all')).toBe('all')
  })
})

describe('extensionMatchesQuery', () => {
  it('matches the extension name, setting titles and raw keys, ignoring case', () => {
    const ports = ext()
    expect(extensionMatchesQuery(ports, 'PORTS')).toBe(true)
    expect(extensionMatchesQuery(ports, 'scan int')).toBe(true)
    expect(extensionMatchesQuery(ports, 'intervalseconds')).toBe(true)
    expect(extensionMatchesQuery(ports, 'api key')).toBe(true)
    expect(extensionMatchesQuery(ports, 'branch')).toBe(false)
  })

  it('matches everything for a blank query', () => {
    expect(extensionMatchesQuery(ext(), '  ')).toBe(true)
  })
})
