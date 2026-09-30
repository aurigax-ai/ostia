import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IconThemeContribution } from '../shared/iconTheme'
import { discoverExtensions } from './extensionManifest'
import {
  ICON_FILE_MAX_BYTES,
  ICON_THEME_MAX_BYTES,
  iconThemeFor,
  loadIconTheme,
  readConfined,
} from './iconThemes'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

const FIXTURE = join(__dirname, '..', '..', 'test', 'fixtures', 'extensions-e2e', 'icons')
const CONTRIBUTION: IconThemeContribution = {
  id: 'fixture-icons',
  label: 'Fixture Icons',
  path: 'dist/fixture-icon-theme.json',
}

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pine-icon-theme-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function copyFixture(): string {
  const dir = join(tmp, 'ext')
  cpSync(FIXTURE, dir, { recursive: true })
  return dir
}

function writeTheme(dir: string, theme: unknown, path = 'theme.json'): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, path), JSON.stringify(theme))
}

describe('loadIconTheme', () => {
  it('loads the fixture theme, turning each icon file into a data URL', () => {
    const res = loadIconTheme(FIXTURE, CONTRIBUTION)
    if (!res.ok) throw new Error(res.error)
    const { theme } = res
    expect(theme.id).toBe('fixture-icons')
    expect(theme.label).toBe('Fixture Icons')
    expect(theme.icons._typescript).toMatch(/^data:image\/svg\+xml;base64,/)
    expect(theme.icons._npm).toMatch(/^data:image\/png;base64,/)
    expect(Buffer.from(theme.icons._file.split(',')[1], 'base64').toString()).toContain('<svg')
    expect(theme.base.file).toBe('_file')
    expect(theme.base.folderExpanded).toBe('_folder_open')
    expect(theme.base.fileExtensions).toEqual({ ts: '_typescript', 'test.ts': '_typescript_test' })
    expect(theme.base.folderNamesExpanded).toEqual({ src: '_folder_src_open' })
    expect(theme.light?.fileExtensions).toEqual({ ts: '_typescript_test' })
    expect(theme.highContrast).toBeUndefined()
  })

  it('skips font-only definitions and associations that point at them', () => {
    const res = loadIconTheme(FIXTURE, CONTRIBUTION)
    if (!res.ok) throw new Error(res.error)
    expect(res.theme.icons._font_only).toBeUndefined()
    expect(res.theme.base.languageIds).toEqual({ markdown: '_markdown' })
  })

  it('lowercases association keys', () => {
    const dir = join(tmp, 'case')
    writeTheme(dir, {
      iconDefinitions: { a: { iconPath: './a.svg' } },
      fileNames: { 'README.MD': 'a' },
    })
    writeFileSync(join(dir, 'a.svg'), '<svg/>')
    const res = loadIconTheme(dir, { id: 'c', label: 'C', path: 'theme.json' })
    expect(res.ok && res.theme.base.fileNames).toEqual({ 'readme.md': 'a' })
  })

  it('refuses a theme file outside the extension folder', () => {
    const dir = join(tmp, 'ext')
    writeTheme(join(tmp, 'elsewhere'), { iconDefinitions: {} })
    mkdirSync(dir)
    const res = loadIconTheme(dir, { id: 'x', label: 'X', path: '../elsewhere/theme.json' })
    expect(res).toEqual({ ok: false, error: '../elsewhere/theme.json: outside the extension' })
  })

  it('refuses a symlinked theme file, even to a file inside the extension', () => {
    const dir = join(tmp, 'ext')
    writeTheme(dir, { iconDefinitions: {} }, 'real.json')
    symlinkSync(join(dir, 'real.json'), join(dir, 'theme.json'))
    const res = loadIconTheme(dir, { id: 'x', label: 'X', path: 'theme.json' })
    expect(res).toEqual({ ok: false, error: 'theme.json: symlink refused' })
  })

  it('refuses a theme file over the size cap', () => {
    const dir = join(tmp, 'ext')
    mkdirSync(dir)
    writeFileSync(join(dir, 'theme.json'), ' '.repeat(ICON_THEME_MAX_BYTES + 1))
    const res = loadIconTheme(dir, { id: 'x', label: 'X', path: 'theme.json' })
    expect(res.ok).toBe(false)
    expect(!res.ok && res.error).toMatch(/larger than/)
  })

  it('reports invalid JSON and a missing iconDefinitions', () => {
    const dir = join(tmp, 'ext')
    mkdirSync(dir)
    writeFileSync(join(dir, 'bad.json'), '{ nope')
    writeTheme(dir, { file: 'x' })
    expect(loadIconTheme(dir, { id: 'x', label: 'X', path: 'bad.json' }).ok).toBe(false)
    expect(loadIconTheme(dir, { id: 'x', label: 'X', path: 'theme.json' })).toEqual({
      ok: false,
      error: 'theme.json: missing iconDefinitions',
    })
  })

  it('drops icons that escape the extension, are symlinks, are too big or are not images', () => {
    const dir = join(tmp, 'ext')
    mkdirSync(join(dir, 'icons'), { recursive: true })
    writeFileSync(join(tmp, 'outside.svg'), '<svg/>')
    writeFileSync(join(dir, 'icons', 'ok.svg'), '<svg/>')
    writeFileSync(join(dir, 'icons', 'big.svg'), 'x'.repeat(ICON_FILE_MAX_BYTES + 1))
    writeFileSync(join(dir, 'icons', 'page.html'), '<script></script>')
    symlinkSync(join(tmp, 'outside.svg'), join(dir, 'icons', 'link.svg'))
    mkdirSync(join(tmp, 'linked-dir'))
    writeFileSync(join(tmp, 'linked-dir', 'inner.svg'), '<svg/>')
    symlinkSync(join(tmp, 'linked-dir'), join(dir, 'icons', 'sub'))
    writeTheme(dir, {
      iconDefinitions: {
        ok: { iconPath: './icons/ok.svg' },
        escape: { iconPath: '../outside.svg' },
        absolute: { iconPath: join(tmp, 'outside.svg') },
        link: { iconPath: './icons/link.svg' },
        viaLinkedDir: { iconPath: './icons/sub/inner.svg' },
        big: { iconPath: './icons/big.svg' },
        html: { iconPath: './icons/page.html' },
        missing: { iconPath: './icons/none.svg' },
      },
      file: 'escape',
      folder: 'ok',
      fileExtensions: { ts: 'link', md: 'ok' },
    })
    const res = loadIconTheme(dir, { id: 'x', label: 'X', path: 'theme.json' })
    if (!res.ok) throw new Error(res.error)
    expect(Object.keys(res.theme.icons)).toEqual(['ok'])
    expect(res.theme.base.file).toBeUndefined()
    expect(res.theme.base.folder).toBe('ok')
    expect(res.theme.base.fileExtensions).toEqual({ md: 'ok' })
  })
})

describe('readConfined', () => {
  it('reads a regular file inside the root', () => {
    writeFileSync(join(tmp, 'a.svg'), '<svg/>')
    const res = readConfined(tmp, join(tmp, 'a.svg'), 100)
    expect(res.ok && res.data.toString()).toBe('<svg/>')
  })

  it('refuses a folder', () => {
    mkdirSync(join(tmp, 'd.svg'))
    expect(readConfined(tmp, join(tmp, 'd.svg'), 100)).toEqual({ ok: false, error: 'not a file' })
  })
})

describe('iconThemeFor', () => {
  it('loads a theme by id from the enabled sources, caches it, and reloads when the file changes', () => {
    const dir = copyFixture()
    const onError = vi.fn()
    const deps = { themes: () => [{ dir, theme: CONTRIBUTION }], onError }
    const first = iconThemeFor('fixture-icons', deps)
    expect(first?.base.fileNames).toEqual({ 'package.json': '_npm' })
    expect(iconThemeFor('fixture-icons', deps)).toBe(first)
    writeFileSync(
      join(dir, 'dist', 'fixture-icon-theme.json'),
      JSON.stringify({
        iconDefinitions: { _file: { iconPath: '../icons/file.svg' } },
        file: '_file',
        fileNames: { 'cargo.toml': '_file' },
      }),
    )
    const second = iconThemeFor('fixture-icons', deps)
    expect(second).not.toBe(first)
    expect(second?.base.fileNames).toEqual({ 'cargo.toml': '_file' })
    expect(onError).not.toHaveBeenCalled()
  })

  it('returns null for an unknown id or a non-string, and reports a broken theme', () => {
    const dir = join(tmp, 'broken')
    mkdirSync(dir)
    writeFileSync(join(dir, 'theme.json'), 'nope')
    const onError = vi.fn()
    const deps = {
      themes: () => [{ dir, theme: { id: 'broken', label: 'B', path: 'theme.json' } }],
      onError,
    }
    expect(iconThemeFor('missing', deps)).toBeNull()
    expect(iconThemeFor(42, deps)).toBeNull()
    expect(iconThemeFor('broken', deps)).toBeNull()
    expect(onError).toHaveBeenCalledWith('broken', expect.stringContaining('theme.json'))
  })
})

describe('manifest contributes.iconThemes', () => {
  it('discovers the fixture extension with its icon theme', () => {
    const root = join(tmp, 'exts')
    cpSync(FIXTURE, join(root, 'icons'), { recursive: true })
    const [ext] = discoverExtensions([{ dir: root, builtin: false }])
    expect(ext.manifest.contributes.iconThemes).toEqual([CONTRIBUTION])
  })
})
