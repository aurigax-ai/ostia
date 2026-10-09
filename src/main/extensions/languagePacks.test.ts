import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExtensionHost } from './extensionHost'
import { ExtensionStore } from './extensionStore'
import {
  LANGUAGE_FILE_MAX_BYTES,
  LANGUAGE_STRING_MAX,
  type LanguageSource,
  loadLanguagePacks,
  normalizeCatalog,
} from './languagePacks'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function extension(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ostia-langpack-'))
  dirs.push(dir)
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), content)
  }
  return dir
}

function source(dir: string, path = 'fr.json', id = 'fr', extId = 'langpack-fr'): LanguageSource {
  return { extId, dir, language: { id, label: 'Français', path } }
}

describe('normalizeCatalog', () => {
  it('keeps nested strings and drops everything else', () => {
    expect(
      normalizeCatalog({
        settings: { title: 'Réglages', count: 3, list: ['a'], nested: { ok: 'Oui', no: null } },
        top: 'Haut',
        long: 'x'.repeat(LANGUAGE_STRING_MAX + 1),
      }),
    ).toEqual({ settings: { title: 'Réglages', nested: { ok: 'Oui' } }, top: 'Haut' })
  })

  it('never copies prototype keys', () => {
    const catalog = normalizeCatalog(
      JSON.parse('{"__proto__": {"polluted": "yes"}, "constructor": {"x": "y"}, "a": "b"}'),
    )
    expect(catalog).toEqual({ a: 'b' })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('refuses anything that is not an object', () => {
    expect(normalizeCatalog(['a'])).toBeNull()
    expect(normalizeCatalog('a')).toBeNull()
    expect(normalizeCatalog(null)).toBeNull()
  })
})

describe('loadLanguagePacks', () => {
  it('returns each enabled extension language with its checked catalog', () => {
    const dir = extension({ 'fr.json': JSON.stringify({ settings: { title: 'Réglages' } }) })
    const onError = vi.fn()
    expect(loadLanguagePacks({ languages: () => [source(dir)], onError })).toEqual([
      {
        extId: 'langpack-fr',
        id: 'fr',
        label: 'Français',
        catalog: { settings: { title: 'Réglages' } },
      },
    ])
    expect(onError).not.toHaveBeenCalled()
  })

  it('skips a symlinked, oversized, missing or broken file and reports why', () => {
    const outside = extension({ 'secret.json': '{"a":"b"}' })
    const dir = extension({
      'big.json': JSON.stringify({ a: 'x'.repeat(LANGUAGE_FILE_MAX_BYTES) }),
      'broken.json': '{nope',
      'list.json': '[]',
    })
    symlinkSync(join(outside, 'secret.json'), join(dir, 'link.json'))
    const errors: string[] = []
    const packs = loadLanguagePacks({
      languages: () => [
        source(dir, 'link.json', 'aa'),
        source(dir, 'big.json', 'bb'),
        source(dir, 'missing.json', 'cc'),
        source(dir, 'broken.json', 'dd'),
        source(dir, 'list.json', 'ee'),
        source(dir, '../secret.json', 'ff'),
      ],
      onError: (_extId, error) => errors.push(error),
    })
    expect(packs).toEqual([])
    expect(errors).toEqual([
      'link.json: symlink refused',
      `big.json: larger than ${LANGUAGE_FILE_MAX_BYTES} bytes`,
      'missing.json: missing',
      'broken.json: not valid JSON',
      'list.json: must be a JSON object',
      '../secret.json: outside the extension',
    ])
  })

  it('the Traditional Chinese pack is an extension: pick it, keep it across a restart, lose it when disabled', () => {
    const root = extension({
      'langpack-zh-hant/ostia.json': JSON.stringify({
        id: 'langpack-zh-hant',
        name: '繁體中文 (Traditional Chinese)',
        version: '1.0.0',
        api: '3.0',
        category: 'langpack',
        locales: ['zh-Hant'],
        contributes: { languages: [{ id: 'zh-Hant', label: '繁體中文', path: 'zh-Hant.json' }] },
      }),
      'langpack-zh-hant/zh-Hant.json': JSON.stringify({ settings: { title: '設定' } }),
    })
    const broadcast = vi.fn()
    const host = new ExtensionHost({
      roots: [{ dir: root, builtin: true }],
      store: new ExtensionStore(join(extension({}), 'extensions.json')),
      socketPath: () => join(root, 'none.sock'),
      nodePath: process.execPath,
      workDirForWorkspace: () => undefined,
      broadcast,
      openPanelIn: vi.fn(),
      notify: vi.fn(),
      log: () => {},
    })
    const deps = { languages: () => host.languages(), onError: vi.fn() }
    expect(loadLanguagePacks(deps)).toEqual([
      {
        extId: 'langpack-zh-hant',
        id: 'zh-Hant',
        label: '繁體中文',
        catalog: { settings: { title: '設定' } },
      },
    ])

    const list = host.setEnabled('langpack-zh-hant', false)

    expect(broadcast).toHaveBeenCalledWith('extensions:changed', list)
    expect(loadLanguagePacks(deps)).toEqual([])
    expect(deps.onError).not.toHaveBeenCalled()
  })

  it('keeps the first extension that provides a language', () => {
    const first = extension({ 'fr.json': '{"a":"un"}' })
    const second = extension({ 'fr.json': '{"a":"deux"}' })
    const onError = vi.fn()
    const packs = loadLanguagePacks({
      languages: () => [source(first), source(second, 'fr.json', 'fr', 'other-fr')],
      onError,
    })
    expect(packs.map((p) => [p.extId, p.catalog.a])).toEqual([['langpack-fr', 'un']])
    expect(onError).toHaveBeenCalledWith('other-fr', "language 'fr' is already provided")
  })
})
