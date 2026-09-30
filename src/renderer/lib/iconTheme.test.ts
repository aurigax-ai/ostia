import type { IconAssociations, LoadedIconTheme } from '@shared/iconTheme'
import { describe, expect, it } from 'vitest'
import { languageIdFor, themeIconId, themeIconSrc } from './iconTheme'

function assoc(extra: Partial<IconAssociations> = {}): IconAssociations {
  return {
    fileExtensions: {},
    fileNames: {},
    folderNames: {},
    folderNamesExpanded: {},
    languageIds: {},
    ...extra,
  }
}

const ids = [
  'file',
  'folder',
  'folder-open',
  'ts',
  'dts',
  'test-ts',
  'npm',
  'lang-ts',
  'lang-py',
  'src',
  'src-open',
  'dist',
  'light-ts',
  'light-file',
  'hc-folder',
]

const THEME: LoadedIconTheme = {
  id: 'fixture',
  label: 'Fixture',
  icons: Object.fromEntries(ids.map((id) => [id, `data:image/svg+xml;base64,${id}`])),
  base: assoc({
    file: 'file',
    folder: 'folder',
    folderExpanded: 'folder-open',
    fileExtensions: { ts: 'ts', 'd.ts': 'dts', 'test.ts': 'test-ts' },
    fileNames: { 'package.json': 'npm', 'weird.test.ts': 'npm' },
    languageIds: { typescript: 'lang-ts', python: 'lang-py' },
    folderNames: { src: 'src', dist: 'dist' },
    folderNamesExpanded: { src: 'src-open' },
  }),
  light: assoc({ fileExtensions: { ts: 'light-ts' }, file: 'light-file' }),
  highContrast: assoc({ folder: 'hc-folder' }),
}

const f = (name: string) => ({ name, dir: false })
const d = (name: string) => ({ name, dir: true })

describe('themeIconId', () => {
  it('prefers fileNames over every extension match', () => {
    expect(themeIconId(THEME, f('package.json'), false)).toBe('npm')
    expect(themeIconId(THEME, f('weird.test.ts'), false)).toBe('npm')
  })

  it('matches the longest file extension first', () => {
    expect(themeIconId(THEME, f('index.d.ts'), false)).toBe('dts')
    expect(themeIconId(THEME, f('a.b.test.ts'), false)).toBe('test-ts')
    expect(themeIconId(THEME, f('main.ts'), false)).toBe('ts')
  })

  it('matches names case-insensitively', () => {
    expect(themeIconId(THEME, f('PACKAGE.JSON'), false)).toBe('npm')
    expect(themeIconId(THEME, f('Main.TS'), false)).toBe('ts')
  })

  it('falls back to languageIds, then to the default file icon', () => {
    expect(themeIconId(THEME, f('app.tsx'), false)).toBe('file')
    expect(themeIconId(THEME, f('mod.mts'), false)).toBe('lang-ts')
    expect(themeIconId(THEME, f('script.py'), false)).toBe('lang-py')
    expect(themeIconId(THEME, f('notes.xyz'), false)).toBe('file')
  })

  it('uses folderNames, then folder, for a collapsed folder', () => {
    expect(themeIconId(THEME, d('src'), false)).toBe('src')
    expect(themeIconId(THEME, d('other'), false)).toBe('folder')
  })

  it('uses folderNamesExpanded, then folderNames, then folderExpanded for an open folder', () => {
    expect(themeIconId(THEME, d('src'), true)).toBe('src-open')
    expect(themeIconId(THEME, d('dist'), true)).toBe('dist')
    expect(themeIconId(THEME, d('other'), true)).toBe('folder-open')
  })

  it('lets the light section override the base in a light theme, keeping base fallbacks', () => {
    expect(themeIconId(THEME, f('main.ts'), false, 'light')).toBe('light-ts')
    expect(themeIconId(THEME, f('notes.xyz'), false, 'light')).toBe('light-file')
    expect(themeIconId(THEME, f('package.json'), false, 'light')).toBe('npm')
    expect(themeIconId(THEME, d('other'), false, 'highContrast')).toBe('hc-folder')
    expect(themeIconId(THEME, d('other'), false, 'dark')).toBe('folder')
  })

  it('never resolves inherited object keys', () => {
    expect(themeIconId(THEME, f('constructor'), false)).toBe('file')
    expect(themeIconId(THEME, d('__proto__'), false)).toBe('folder')
  })
})

describe('themeIconSrc', () => {
  it('returns the data URL of the resolved definition', () => {
    expect(themeIconSrc(THEME, f('main.ts'), false)).toBe('data:image/svg+xml;base64,ts')
  })

  it('returns null when the theme has no icon for the entry', () => {
    const bare: LoadedIconTheme = { id: 'b', label: 'B', icons: {}, base: assoc() }
    expect(themeIconSrc(bare, f('main.ts'), false)).toBeNull()
  })
})

describe('languageIdFor', () => {
  it('maps extensions and well-known names to VS Code language ids', () => {
    expect(languageIdFor('a.tsx')).toBe('typescriptreact')
    expect(languageIdFor('run.sh')).toBe('shellscript')
    expect(languageIdFor('Dockerfile')).toBe('dockerfile')
    expect(languageIdFor('unknown.zzz')).toBeUndefined()
  })
})
