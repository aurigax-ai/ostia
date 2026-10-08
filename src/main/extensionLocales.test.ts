import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EXTENSION_LOCALE_FILE_MAX_BYTES } from '../shared/extensionLocales'
import type { ExtensionManifest } from '../shared/extensions'
import {
  loadLocaleCatalogs,
  localeProblems,
  localizeManifest,
  manifestIn,
  manifestSlots,
  parseLocaleCatalog,
  readLocaleCatalog,
} from './extensionLocales'
import { parseManifest, readManifest } from './extensionManifest'

const repoRoot = resolve(__dirname, '../..')

function manifestOf(raw: Record<string, unknown>): ExtensionManifest {
  const res = parseManifest(
    { id: 'demo', name: 'Demo', version: '1.0.0', api: '3.0', ...raw },
    '/x',
  )
  if (!res.ok) throw new Error(res.error)
  return res.manifest
}

const demo = manifestOf({
  description: 'A demo',
  main: 'main.js',
  locales: ['zh-Hant'],
  contributes: {
    commands: [
      { id: 'run', title: 'Run', category: 'Demo', argument: 'Target' },
      { id: 'stop', title: 'Stop' },
    ],
    panel: { title: 'Demo panel', entry: 'url' },
    settingsPage: { title: 'Demo settings', icon: 'puzzle' },
    paneChips: [{ id: 'state', title: 'State' }],
    workspaceChips: [{ id: 'count', title: 'Count' }],
    settings: {
      mode: {
        type: 'enum',
        title: 'Mode',
        values: ['fast', 'slow'],
        valueTitles: { fast: 'Fast' },
        default: 'fast',
        description: 'How it runs',
      },
      plain: { type: 'boolean', default: true, description: 'No title here' },
    },
    secrets: { token: { title: 'Token', description: 'The token' } },
  },
})

describe('manifestSlots', () => {
  it('lists exactly the human text the manifest declares', () => {
    expect([...manifestSlots(demo).keys()].sort()).toEqual(
      [
        'name',
        'description',
        'commands.run.title',
        'commands.run.category',
        'commands.run.argument',
        'commands.stop.title',
        'panel.title',
        'settingsPage.title',
        'paneChips.state.title',
        'workspaceChips.count.title',
        'settings.mode.title',
        'settings.mode.description',
        'settings.mode.valueTitles.fast',
        'settings.plain.description',
        'secrets.token.title',
        'secrets.token.description',
      ].sort(),
    )
  })
})

describe('parseLocaleCatalog', () => {
  it('keeps translations of declared strings', () => {
    const res = parseLocaleCatalog(
      { manifest: { name: '示範', 'commands.run.title': '執行' }, messages: { hi: '嗨' } },
      demo,
    )
    expect(res?.problems).toEqual([])
    expect({ ...res?.manifest }).toEqual({ name: '示範', 'commands.run.title': '執行' })
    expect({ ...res?.messages }).toEqual({ hi: '嗨' })
  })

  it('refuses a key the manifest does not declare, so a catalog cannot add a command or a setting', () => {
    const res = parseLocaleCatalog(
      {
        manifest: {
          'commands.wipe.title': 'Wipe',
          'settings.plain.title': 'Added title',
          'settings.mode.valueTitles.slow': 'Slow',
          'commands.run.usage': 'run now',
          id: 'other',
        },
      },
      demo,
    )
    expect({ ...res?.manifest }).toEqual({})
    expect(res?.problems).toHaveLength(5)
    expect(res?.problems[0]).toBe(
      "manifest.commands.wipe.title: not a string this extension's manifest declares",
    )
  })

  it('refuses values that are not strings, are empty, too long or hold control characters', () => {
    const res = parseLocaleCatalog(
      {
        manifest: {
          name: 7,
          description: { nested: 'text' },
          'commands.run.title': '   ',
          'commands.run.argument': 'x'.repeat(81),
          'panel.title': 'two\nlines',
          'settingsPage.title': 'x'.repeat(81),
        },
      },
      demo,
    )
    expect({ ...res?.manifest }).toEqual({})
    expect(res?.problems).toEqual([
      'manifest.name: must be a string',
      'manifest.description: must be a string',
      'manifest.commands.run.title: must be 1-200 characters',
      'manifest.commands.run.argument: must be 1-80 characters',
      'manifest.panel.title: must not contain control characters',
      'manifest.settingsPage.title: must be 1-80 characters',
    ])
  })

  it('drops prototype keys and leaves the prototype alone', () => {
    const raw = JSON.parse(
      '{"manifest":{"__proto__":"x","constructor":"y","prototype":"z","name":"示範"}}',
    )
    const res = parseLocaleCatalog(raw, demo)
    expect({ ...res?.manifest }).toEqual({ name: '示範' })
    expect(Object.getPrototypeOf(res?.manifest)).toBeNull()
    expect(res?.problems).toHaveLength(3)
    expect(({} as Record<string, unknown>).x).toBeUndefined()
  })

  it('reports sections it does not know and a manifest section that is not an object', () => {
    expect(parseLocaleCatalog({ commands: {}, manifest: ['name'] }, demo)?.problems).toEqual([
      'commands: unknown section (a catalog holds manifest and messages)',
      'manifest must be an object of strings',
    ])
    expect(parseLocaleCatalog(['name'], demo)).toBeNull()
  })
})

describe('reading catalogs from an extension folder', () => {
  let dir: string
  let outside: string

  const write = (name: string, value: unknown): void => {
    mkdirSync(join(dir, 'locales'), { recursive: true })
    writeFileSync(
      join(dir, 'locales', name),
      typeof value === 'string' ? value : JSON.stringify(value),
    )
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ostia-ext-locales-'))
    outside = mkdtempSync(join(tmpdir(), 'ostia-ext-outside-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it('loads the declared catalog', () => {
    write('zh-Hant.json', { manifest: { name: '示範' } })
    const problems: string[] = []
    const catalogs = loadLocaleCatalogs(dir, demo, (p) => problems.push(p))
    expect({ ...catalogs['zh-Hant'] }).toEqual({ name: '示範' })
    expect(problems).toEqual([])
  })

  it('refuses a catalog that is a symlink', () => {
    writeFileSync(join(outside, 'zh-Hant.json'), JSON.stringify({ manifest: { name: '外面' } }))
    mkdirSync(join(dir, 'locales'))
    symlinkSync(join(outside, 'zh-Hant.json'), join(dir, 'locales', 'zh-Hant.json'))
    expect(readLocaleCatalog(dir, 'zh-Hant', demo)).toEqual({ ok: false, error: 'symlink refused' })
  })

  it('refuses a locales folder that links outside the extension', () => {
    writeFileSync(join(outside, 'zh-Hant.json'), JSON.stringify({ manifest: { name: '外面' } }))
    symlinkSync(outside, join(dir, 'locales'))
    expect(readLocaleCatalog(dir, 'zh-Hant', demo)).toEqual({
      ok: false,
      error: 'outside the extension',
    })
  })

  it('refuses a locales folder that is a link to another folder of the extension', () => {
    mkdirSync(join(dir, 'elsewhere'))
    writeFileSync(
      join(dir, 'elsewhere', 'zh-Hant.json'),
      JSON.stringify({ manifest: { name: '別處' } }),
    )
    symlinkSync(join(dir, 'elsewhere'), join(dir, 'locales'))
    expect(readLocaleCatalog(dir, 'zh-Hant', demo)).toEqual({ ok: false, error: 'symlink refused' })
  })

  it('refuses a catalog past the size cap', () => {
    write('zh-Hant.json', `{"messages":{"a":"${'x'.repeat(EXTENSION_LOCALE_FILE_MAX_BYTES)}"}}`)
    expect(readLocaleCatalog(dir, 'zh-Hant', demo)).toEqual({
      ok: false,
      error: `larger than ${EXTENSION_LOCALE_FILE_MAX_BYTES} bytes`,
    })
  })

  it('reports a missing, unparsable or non-object catalog and keeps English', () => {
    const problems: string[] = []
    expect(loadLocaleCatalogs(dir, demo, (p) => problems.push(p))).toEqual({})
    write('zh-Hant.json', '{nope')
    loadLocaleCatalogs(dir, demo, (p) => problems.push(p))
    write('zh-Hant.json', '[]')
    loadLocaleCatalogs(dir, demo, (p) => problems.push(p))
    expect(problems).toEqual([
      'locales/zh-Hant.json: missing',
      'locales/zh-Hant.json: not valid JSON',
      'locales/zh-Hant.json: must be a JSON object',
    ])
  })

  it('keeps the valid strings of a catalog that also holds bad ones', () => {
    write('zh-Hant.json', { manifest: { name: '示範', 'commands.wipe.title': 'Wipe' } })
    const problems: string[] = []
    const catalogs = loadLocaleCatalogs(dir, demo, (p) => problems.push(p))
    expect({ ...catalogs['zh-Hant'] }).toEqual({ name: '示範' })
    expect(problems).toEqual([
      "locales/zh-Hant.json: manifest.commands.wipe.title: not a string this extension's manifest declares",
    ])
  })

  it('never reads a catalog the manifest does not list', () => {
    write('fr.json', { manifest: { name: 'Démo' } })
    write('zh-Hant.json', { manifest: { name: '示範' } })
    expect(Object.keys(loadLocaleCatalogs(dir, demo))).toEqual(['zh-Hant'])
  })

  it('tells an author about a manifest translation that is not listed', () => {
    write('zh-Hant.json', { manifest: { name: '示範' } })
    write('fr.json', { manifest: { name: 'Démo' } })
    write('en.json', { messages: { hello: 'Hello' } })
    expect(localeProblems(dir, demo)).toEqual([
      "locales/fr.json: translates the manifest but 'fr' is not listed in locales",
    ])
  })
})

describe('localizeManifest', () => {
  const strings = {
    name: '示範',
    'commands.run.title': '執行',
    'commands.run.category': '示範類',
    'commands.run.argument': '目標',
    'panel.title': '示範面板',
    'settingsPage.title': '示範設定',
    'paneChips.state.title': '狀態',
    'workspaceChips.count.title': '數量',
    'settings.mode.title': '模式',
    'settings.mode.description': '執行方式',
    'settings.mode.valueTitles.fast': '快速',
    'secrets.token.title': '權杖',
    'secrets.token.description': '這個權杖',
  }

  it('replaces every translated string and keeps everything else', () => {
    const shown = localizeManifest(demo, strings)
    expect(shown.name).toBe('示範')
    expect(shown.contributes.commands[0]).toEqual({
      ...demo.contributes.commands[0],
      title: '執行',
      category: '示範類',
      argument: '目標',
    })
    expect(shown.contributes.panel).toEqual({ title: '示範面板', entry: 'url' })
    expect(shown.contributes.settingsPage).toEqual({ title: '示範設定', icon: 'puzzle' })
    expect(shown.contributes.paneChips).toEqual([{ id: 'state', title: '狀態' }])
    expect(shown.contributes.workspaceChips).toEqual([{ id: 'count', title: '數量' }])
    expect(shown.contributes.settings[0]).toMatchObject({
      key: 'mode',
      title: '模式',
      description: '執行方式',
      values: ['fast', 'slow'],
      valueTitles: { fast: '快速' },
      default: 'fast',
    })
    expect(shown.contributes.secrets).toEqual([
      { key: 'token', title: '權杖', description: '這個權杖' },
    ])
  })

  it('falls back to the manifest string by string', () => {
    const shown = localizeManifest(demo, { name: '示範' })
    expect(shown.description).toBe('A demo')
    expect(shown.contributes.commands.map((c) => c.title)).toEqual(['Run', 'Stop'])
    expect(shown.contributes.settingsPage).toEqual({ title: 'Demo settings', icon: 'puzzle' })
    expect(shown.contributes.settings[1]).toEqual(demo.contributes.settings[1])
  })

  it('adds no settings page to a manifest without one', () => {
    const plain = manifestOf({
      contributes: { settings: { on: { type: 'boolean', default: true, description: 'On' } } },
    })
    expect(manifestSlots(plain).has('settingsPage.title')).toBe(false)
    expect(
      localizeManifest(plain, { 'settingsPage.title': '設定' }).contributes,
    ).not.toHaveProperty('settingsPage')
  })

  it('leaves the manifest it was given untouched', () => {
    localizeManifest(demo, strings)
    expect(demo.name).toBe('Demo')
    expect(demo.contributes.commands[0].title).toBe('Run')
  })
})

describe('manifestIn', () => {
  const catalogs = { 'zh-Hant': { name: '示範' } }

  it('resolves for the language and its regional forms', () => {
    expect(manifestIn(demo, catalogs, 'zh-Hant').name).toBe('示範')
    expect(manifestIn(demo, catalogs, 'zh-Hant-TW').name).toBe('示範')
  })

  it('returns the manifest itself for English, an unknown language or no locale', () => {
    expect(manifestIn(demo, catalogs, 'en')).toBe(demo)
    expect(manifestIn(demo, catalogs, 'fr')).toBe(demo)
    expect(manifestIn(demo, catalogs, undefined)).toBe(demo)
  })
})

describe('the catalogs shipped in this repository', () => {
  const extensions = join(repoRoot, 'src/extensions')
  const dirs = [
    ...readdirSync(extensions)
      .filter((id) => id !== 'sdk')
      .map((id) => join(extensions, id)),
    join(repoRoot, 'sdk/template'),
    join(repoRoot, 'test/fixtures/extensions-e2e/hello'),
  ]

  it('translate only strings their manifest declares', () => {
    for (const dir of dirs) {
      const res = readManifest(dir)
      if (!res.ok) throw new Error(`${dir}: ${res.error}`)
      expect(localeProblems(dir, res.manifest), dir).toEqual([])
    }
  })

  it('give every extension with human text a Traditional Chinese catalog', () => {
    for (const id of readdirSync(extensions).filter(
      (d) => d !== 'sdk' && !d.startsWith('langpack'),
    )) {
      const manifest = JSON.parse(readFileSync(join(extensions, id, 'ostia.json'), 'utf8'))
      expect(manifest.locales, id).toEqual(['zh-Hant'])
    }
  })
})
