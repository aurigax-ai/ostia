import { useSettingsStore } from '@/stores/app/settingsStore'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  DEFAULT_FILE_TREE_SETTINGS,
  DEFAULT_NESTING_PATTERNS,
  EXCLUDE_MAX,
  parseFileTreeSettings,
} from './fileTreeSettings'

describe('parseFileTreeSettings', () => {
  it('returns the defaults when files is missing or not an object', () => {
    expect(parseFileTreeSettings(undefined)).toEqual(DEFAULT_FILE_TREE_SETTINGS)
    expect(parseFileTreeSettings([])).toEqual(DEFAULT_FILE_TREE_SETTINGS)
  })

  it('hides VCS folders and OS litter by default, compacts folders and nests files', () => {
    expect(DEFAULT_FILE_TREE_SETTINGS.exclude).toContain('**/.git')
    expect(DEFAULT_FILE_TREE_SETTINGS.exclude).toContain('**/.DS_Store')
    expect(DEFAULT_FILE_TREE_SETTINGS.compactFolders).toBe(true)
    expect(DEFAULT_FILE_TREE_SETTINGS.nesting.enabled).toBe(true)
    expect(DEFAULT_NESTING_PATTERNS['package.json']).toContain('pnpm-lock.yaml')
    expect(DEFAULT_NESTING_PATTERNS['Cargo.toml']).toBe('Cargo.lock')
  })

  it('trims, dedupes and caps exclude patterns and drops non-strings', () => {
    const parsed = parseFileTreeSettings({
      exclude: [' **/dist ', '**/dist', 7, '', '**/.*'],
    })
    expect(parsed.exclude).toEqual(['**/dist', '**/.*'])
    const many = parseFileTreeSettings({ exclude: Array.from({ length: 500 }, (_, i) => `p${i}`) })
    expect(many.exclude).toHaveLength(EXCLUDE_MAX)
  })

  it('keeps an empty exclude list the user chose', () => {
    expect(parseFileTreeSettings({ exclude: [] }).exclude).toEqual([])
  })

  it('replaces the default nesting patterns with the user map, dropping non-string values', () => {
    const parsed = parseFileTreeSettings({
      nesting: { enabled: false, patterns: { '*.go': '${capture}_test.go', bad: 3 } },
    })
    expect(parsed.nesting).toEqual({ enabled: false, patterns: { '*.go': '${capture}_test.go' } })
  })

  it('falls back to the default sort and icon theme for unknown values', () => {
    const parsed = parseFileTreeSettings({ sortOrder: 'weird', sortBy: 'size', iconTheme: '../x' })
    expect(parsed.sortOrder).toBe('foldersFirst')
    expect(parsed.sortBy).toBe('name')
    expect(parsed.iconTheme).toBe('ostia')
    expect(parseFileTreeSettings({ iconTheme: 'ostia' }).iconTheme).toBe('ostia')
    expect(parseFileTreeSettings({ iconTheme: 'material-icon-theme' }).iconTheme).toBe(
      'material-icon-theme',
    )
  })
})

describe('files settings through the store', () => {
  let init: ReturnType<typeof useSettingsStore.getState>
  beforeAll(() => {
    init = useSettingsStore.getState()
  })
  afterEach(() => {
    useSettingsStore.setState(init, true)
  })

  it('lets ostia settings set change files.* keys and refuses invalid values', () => {
    useSettingsStore.getState().setByPath('files.compactFolders', false)
    expect(useSettingsStore.getState().files.compactFolders).toBe(false)
    useSettingsStore.getState().setByPath('files.exclude', ['**/node_modules'])
    expect(useSettingsStore.getState().files.exclude).toEqual(['**/node_modules'])
    expect(() => useSettingsStore.getState().setByPath('files.sortBy', 'size')).toThrow(
      /invalid value/,
    )
  })

  it('setFiles merges the patch and normalizes it', () => {
    useSettingsStore.getState().setFiles({ exclude: ['  **/dist  '], sortOrder: 'mixed' })
    const files = useSettingsStore.getState().files
    expect(files.exclude).toEqual(['**/dist'])
    expect(files.sortOrder).toBe('mixed')
    expect(files.compactFolders).toBe(true)
  })
})
