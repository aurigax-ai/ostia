import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EXTENSION_API_VERSION } from '../shared/extensionApi'
import { discoverExtensions, isInsideDir, parseManifest } from './extensionManifest'

const DIR = '/ext/demo'

function manifest(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'demo', name: 'Demo', version: '1.0.0', api: '1.0', main: 'main.js', ...extra }
}

describe('parseManifest', () => {
  it('accepts a full manifest and fills contribution defaults', () => {
    const res = parseManifest(
      manifest({
        description: 'd',
        capabilities: ['notify', 'read-board'],
        contributes: {
          commands: [
            { id: 'open', title: 'Open Demo', category: 'App', capabilities: ['read-board'] },
            { id: 'set', title: 'Set', palette: false, stdin: true, usage: 'set <k>' },
          ],
          sidebarItems: true,
          panel: { title: 'Demo', icon: 'puzzle', entry: 'ui/panel.html' },
        },
      }),
      DIR,
    )
    expect(res).toEqual({
      ok: true,
      manifest: {
        id: 'demo',
        name: 'Demo',
        version: '1.0.0',
        api: '1.0',
        description: 'd',
        category: 'other',
        capabilities: ['notify', 'read-board'],
        main: 'main.js',
        contributes: {
          commands: [
            {
              id: 'open',
              title: 'Open Demo',
              category: 'App',
              palette: true,
              stdin: false,
              capabilities: ['read-board'],
            },
            {
              id: 'set',
              title: 'Set',
              usage: 'set <k>',
              palette: false,
              stdin: true,
              capabilities: [],
            },
          ],
          sidebarItems: true,
          panel: { title: 'Demo', icon: 'puzzle', entry: 'ui/panel.html' },
          paneChips: [],
          workspaceChips: [],
          settings: [],
          assist: [],
          secrets: [],
        },
      },
    })
  })

  it('parses assist points and secrets, and requires the assist capability', () => {
    const ok = parseManifest(
      manifest({
        capabilities: ['assist'],
        contributes: {
          assist: ['chat', 'command', 'chat'],
          secrets: { apiKey: { description: 'Provider key' } },
        },
      }),
      DIR,
    )
    expect(ok.ok && ok.manifest.contributes.assist).toEqual(['chat', 'command'])
    expect(ok.ok && ok.manifest.contributes.secrets).toEqual([
      { key: 'apiKey', description: 'Provider key' },
    ])
    expect(parseManifest(manifest({ contributes: { assist: ['chat'] } }), DIR)).toEqual({
      ok: false,
      error: "contributes.assist needs the 'assist' capability",
    })
    expect(
      parseManifest(manifest({ capabilities: ['assist'], contributes: { assist: ['shell'] } }), DIR)
        .ok,
    ).toBe(false)
    expect(
      parseManifest(
        {
          id: 'demo',
          name: 'Demo',
          version: '1',
          api: '1.0',
          capabilities: ['assist'],
          contributes: { assist: ['chat'] },
        },
        DIR,
      ).ok,
    ).toBe(false)
    expect(parseManifest(manifest({ contributes: { secrets: { apiKey: {} } } }), DIR)).toEqual({
      ok: false,
      error: 'contributes.secrets.apiKey: missing description',
    })
  })

  it('parses pane chips and typed settings in manifest order', () => {
    const res = parseManifest(
      manifest({
        contributes: {
          paneChips: [
            { id: 'branch', title: 'Git branch' },
            { id: 'env', title: 'Python env' },
          ],
          settings: {
            interval: { type: 'number', default: 5, description: 'Poll every N seconds' },
            label: { type: 'string', default: '', description: 'Shown text' },
            loud: { type: 'boolean', default: false, description: 'Notify' },
            mode: {
              type: 'enum',
              values: ['fast', 'slow', 'fast'],
              default: 'slow',
              description: 'Speed',
            },
          },
        },
      }),
      DIR,
    )
    if (!res.ok) throw new Error(res.error)
    expect(res.manifest.contributes.paneChips).toEqual([
      { id: 'branch', title: 'Git branch' },
      { id: 'env', title: 'Python env' },
    ])
    expect(res.manifest.contributes.settings).toEqual([
      { key: 'interval', type: 'number', default: 5, description: 'Poll every N seconds' },
      { key: 'label', type: 'string', default: '', description: 'Shown text' },
      { key: 'loud', type: 'boolean', default: false, description: 'Notify' },
      {
        key: 'mode',
        type: 'enum',
        values: ['fast', 'slow'],
        default: 'slow',
        description: 'Speed',
      },
    ])
  })

  it('keeps setting and secret titles, value titles, bounds and units', () => {
    const res = parseManifest(
      manifest({
        contributes: {
          settings: {
            intervalSeconds: {
              type: 'number',
              title: 'Scan interval',
              default: 3,
              minimum: 1,
              maximum: 60,
              unit: 'seconds',
              description: 'Time between scans while {product} is focused',
            },
            scope: {
              type: 'enum',
              values: ['current', 'all'],
              valueTitles: { current: 'Current branch', all: 'All branches' },
              default: 'current',
              description: 'Branches',
            },
            plain: { type: 'boolean', default: true, description: 'No title' },
          },
          secrets: { apiKey: { title: 'API key', description: 'Key' } },
        },
      }),
      DIR,
    )
    if (!res.ok) throw new Error(res.error)
    expect(res.manifest.contributes.settings).toEqual([
      {
        key: 'intervalSeconds',
        type: 'number',
        title: 'Scan interval',
        default: 3,
        minimum: 1,
        maximum: 60,
        unit: 'seconds',
        description: 'Time between scans while {product} is focused',
      },
      {
        key: 'scope',
        type: 'enum',
        values: ['current', 'all'],
        valueTitles: { current: 'Current branch', all: 'All branches' },
        default: 'current',
        description: 'Branches',
      },
      { key: 'plain', type: 'boolean', default: true, description: 'No title' },
    ])
    expect(res.manifest.contributes.secrets).toEqual([
      { key: 'apiKey', title: 'API key', description: 'Key' },
    ])
  })

  it('rejects a bad title, value title, bound or unit', () => {
    const setting = (s: Record<string, unknown>) =>
      parseManifest(manifest({ contributes: { settings: { k: s } } }), DIR)
    const number = { type: 'number', default: 5, description: 'd' }
    expect(setting({ ...number, title: '' })).toEqual({
      ok: false,
      error: 'contributes.settings.k: title must be 1-80 characters',
    })
    expect(setting({ ...number, title: 'x'.repeat(81) }).ok).toBe(false)
    expect(setting({ ...number, title: 'two\nlines' }).ok).toBe(false)
    expect(setting({ ...number, title: 7 }).ok).toBe(false)
    expect(setting({ ...number, minimum: 6 })).toEqual({
      ok: false,
      error: 'contributes.settings.k: default does not match type number',
    })
    expect(setting({ ...number, minimum: 9, maximum: 1 })).toEqual({
      ok: false,
      error: 'contributes.settings.k: minimum is greater than maximum',
    })
    expect(setting({ ...number, maximum: '10' }).ok).toBe(false)
    expect(setting({ ...number, unit: 'hours' }).ok).toBe(false)
    expect(setting({ type: 'string', default: '', description: 'd', unit: 'seconds' })).toEqual({
      ok: false,
      error: 'contributes.settings.k: minimum, maximum and unit are for number settings',
    })
    const enumSetting = { type: 'enum', values: ['a'], default: 'a', description: 'd' }
    expect(setting({ ...enumSetting, valueTitles: { b: 'B' } })).toEqual({
      ok: false,
      error: 'contributes.settings.k: valueTitles.b is not one of the values',
    })
    expect(setting({ ...enumSetting, valueTitles: { a: '' } }).ok).toBe(false)
    expect(setting({ ...number, valueTitles: {} }).ok).toBe(false)
    expect(
      parseManifest(
        manifest({ contributes: { secrets: { apiKey: { title: '', description: 'd' } } } }),
        DIR,
      ),
    ).toEqual({ ok: false, error: 'contributes.secrets.apiKey: title must be 1-80 characters' })
  })

  it('takes language servers as data, without a main process, when the capability is declared', () => {
    const languageServers = [
      {
        id: 'pyright',
        name: 'Pyright',
        languages: ['python'],
        run: { node: 'server/langserver.index.js', args: ['--stdio'] },
        settingPaths: { mode: 'python.analysis.typeCheckingMode' },
      },
    ]
    const settings = {
      mode: { type: 'enum', values: ['basic', 'strict'], default: 'basic', description: 'Mode' },
    }
    const base = { id: 'lsp-demo', name: 'Demo', version: '1.0.0', api: '1.0' }
    const res = parseManifest(
      {
        ...base,
        category: 'languages',
        capabilities: ['language-server'],
        contributes: { settings, languageServers },
      },
      DIR,
    )
    expect(res.ok && res.manifest.main).toBeUndefined()
    expect(res.ok && res.manifest.category).toBe('languages')
    expect(res.ok && res.manifest.contributes.languageServers).toEqual([
      { ...languageServers[0], rootMarkers: [] },
    ])
    expect(parseManifest({ ...base, contributes: { settings, languageServers } }, DIR)).toEqual({
      ok: false,
      error: "contributes.languageServers needs the 'language-server' capability",
    })
    expect(
      parseManifest(
        {
          ...base,
          capabilities: ['language-server'],
          contributes: {
            languageServers: [{ ...languageServers[0], run: { node: '../../evil.js' } }],
          },
        },
        DIR,
      ),
    ).toMatchObject({ ok: false, error: expect.stringContaining('inside the extension') })
    expect(
      parseManifest(
        { ...base, capabilities: ['language-server'], contributes: { languageServers } },
        DIR,
      ),
    ).toMatchObject({ ok: false, error: expect.stringContaining("extension's settings") })
  })

  it('defaults the category to other and refuses one it does not know', () => {
    const res = parseManifest(manifest({}), DIR)
    expect(res.ok && res.manifest.category).toBe('other')
    const scm = parseManifest(manifest({ category: 'scm' }), DIR)
    expect(scm.ok && scm.manifest.category).toBe('scm')
    expect(parseManifest(manifest({ category: 'games' }), DIR)).toEqual({
      ok: false,
      error:
        'category must be one of ai, scm, tools, themes, langpack, completions, languages, other',
    })
  })

  it('requires an extension API version this app provides', () => {
    const { api: _api, ...withoutApi } = manifest()
    expect(parseManifest(withoutApi, DIR)).toEqual({ ok: false, error: 'missing api' })
    expect(parseManifest(manifest({ api: 'latest' }), DIR)).toEqual({
      ok: false,
      error: 'api must be an extension API version such as 1.0',
    })
    const [major, minor] = EXTENSION_API_VERSION.split('.').map(Number)
    for (const api of [`${major}.${minor + 1}`, `${major + 1}.0`]) {
      expect(parseManifest(manifest({ api }), DIR)).toEqual({
        ok: false,
        error: `needs extension API ${api}; this pine provides ${EXTENSION_API_VERSION}`,
      })
    }
    const ok = parseManifest(manifest({ api: EXTENSION_API_VERSION }), DIR)
    expect(ok.ok && ok.manifest.api).toBe(EXTENSION_API_VERSION)
  })

  it('accepts language packs and checks their tag, label and file', () => {
    const languages = (list: unknown) =>
      parseManifest(manifest({ contributes: { languages: list } }), DIR)
    const ok = languages([{ id: 'zh-Hant', label: '繁體中文', path: 'zh-Hant.json' }])
    expect(ok.ok && ok.manifest.contributes.languages).toEqual([
      { id: 'zh-Hant', label: '繁體中文', path: 'zh-Hant.json' },
    ])
    expect(languages([{ id: 'french!', label: 'F', path: 'fr.json' }])).toEqual({
      ok: false,
      error: 'contributes.languages[0]: id must be a language tag such as fr or zh-Hant',
    })
    expect(languages([{ id: 'fr', label: 'F', path: '../fr.json' }])).toEqual({
      ok: false,
      error: 'contributes.languages[0]: path must be a .json file inside the extension',
    })
    expect(
      languages([
        { id: 'fr', label: 'F', path: 'fr.json' },
        { id: 'fr', label: 'G', path: 'fr2.json' },
      ]),
    ).toEqual({ ok: false, error: "contributes.languages[1]: duplicate id 'fr'" })
  })

  it('accepts every built-in and marketplace manifest', () => {
    for (const id of [
      'assistant',
      'completions',
      'git',
      'keeper',
      'langpack-zh-hant',
      'lsp-clangd',
      'lsp-gopls',
      'lsp-lua',
      'lsp-rust-analyzer',
      'model-runtime',
      'ports',
      'system',
      'trellis',
    ]) {
      const dir = join(__dirname, '..', 'extensions', id)
      const raw: unknown = JSON.parse(readFileSync(join(dir, 'pine.json'), 'utf8'))
      const res = parseManifest(raw, dir)
      expect(res.ok ? null : res.error, id).toBeNull()
    }
  })

  it('rejects a setting whose default does not match its type', () => {
    const setting = (s: Record<string, unknown>) =>
      parseManifest(manifest({ contributes: { settings: { k: s } } }), DIR)
    expect(setting({ type: 'number', default: '5', description: 'd' })).toEqual({
      ok: false,
      error: 'contributes.settings.k: default does not match type number',
    })
    expect(setting({ type: 'enum', values: ['a'], default: 'b', description: 'd' }).ok).toBe(false)
    expect(setting({ type: 'enum', default: 'a', description: 'd' }).ok).toBe(false)
    expect(setting({ type: 'date', default: 'x', description: 'd' }).ok).toBe(false)
    expect(setting({ type: 'boolean', default: true }).ok).toBe(false)
    expect(
      parseManifest(
        manifest({ contributes: { settings: { 'bad key': { type: 'boolean', default: true } } } }),
        DIR,
      ).ok,
    ).toBe(false)
  })

  it('rejects duplicate pane chips and pane chips without a process', () => {
    const dup = {
      paneChips: [
        { id: 'a', title: 'A' },
        { id: 'a', title: 'B' },
      ],
    }
    expect(parseManifest(manifest({ contributes: dup }), DIR).ok).toBe(false)
    const noMain = {
      id: 'demo',
      name: 'Demo',
      version: '1',
      api: '1.0',
      contributes: { paneChips: [{ id: 'a', title: 'A' }] },
    }
    expect(parseManifest(noMain, DIR).ok).toBe(false)
  })

  it('marks a command interactive only when the manifest says exactly true', () => {
    const res = parseManifest(
      manifest({
        contributes: {
          commands: [
            { id: 'ask', title: 'Ask', interactive: true },
            { id: 'quick', title: 'Quick', interactive: 'yes' },
          ],
        },
      }),
      DIR,
    )
    if (!res.ok) throw new Error(res.error)
    const [ask, quick] = res.manifest.contributes.commands
    expect(ask.interactive).toBe(true)
    expect(quick).not.toHaveProperty('interactive')
  })

  it('keeps a command argument label only when it is short text', () => {
    const res = parseManifest(
      manifest({
        contributes: {
          commands: [
            { id: 'card', title: 'Open Card', argument: 'Card id' },
            { id: 'long', title: 'Long', argument: 'x'.repeat(81) },
            { id: 'odd', title: 'Odd', argument: 3 },
          ],
        },
      }),
      DIR,
    )
    if (!res.ok) throw new Error(res.error)
    const [card, long, odd] = res.manifest.contributes.commands
    expect(card.argument).toBe('Card id')
    expect(long).not.toHaveProperty('argument')
    expect(odd).not.toHaveProperty('argument')
  })

  it('rejects ids that are not lowercase slugs', () => {
    for (const id of ['Demo', '../x', 'a', '__proto__', 'x'.repeat(41), 7]) {
      expect(parseManifest(manifest({ id }), DIR).ok).toBe(false)
    }
  })

  it('rejects unknown capabilities, both top-level and per command', () => {
    expect(parseManifest(manifest({ capabilities: ['root'] }), DIR)).toEqual({
      ok: false,
      error: "manifest: unknown capability 'root'",
    })
    const res = parseManifest(
      manifest({ contributes: { commands: [{ id: 'x', title: 'X', capabilities: ['nope'] }] } }),
      DIR,
    )
    expect(res.ok).toBe(false)
  })

  it('rejects a main or panel entry that escapes the extension directory', () => {
    expect(parseManifest(manifest({ main: '../evil.js' }), DIR).ok).toBe(false)
    expect(parseManifest(manifest({ main: '/usr/bin/evil' }), DIR).ok).toBe(false)
    const panel = (entry: string) =>
      parseManifest(manifest({ contributes: { panel: { title: 'P', entry } } }), DIR).ok
    expect(panel('../other/panel.html')).toBe(false)
    expect(panel('panel.js')).toBe(false)
    expect(panel('url')).toBe(true)
    expect(panel('panel.html')).toBe(true)
  })

  it('rejects duplicate command ids and commands without a process', () => {
    const dup = {
      commands: [
        { id: 'a', title: 'A' },
        { id: 'a', title: 'B' },
      ],
    }
    expect(parseManifest(manifest({ contributes: dup }), DIR)).toEqual({
      ok: false,
      error: "duplicate command 'a'",
    })
    const noMain = {
      id: 'demo',
      name: 'Demo',
      version: '1',
      api: '1.0',
      contributes: { sidebarItems: true },
    }
    expect(parseManifest(noMain, DIR).ok).toBe(false)
  })

  it('allows a process-less extension that only ships a file panel', () => {
    const res = parseManifest(
      {
        id: 'static',
        name: 'S',
        version: '1',
        api: '1.0',
        contributes: { panel: { title: 'S', entry: 'p.html' } },
      },
      DIR,
    )
    expect(res.ok).toBe(true)
  })

  it('drops an unknown panel icon instead of failing', () => {
    const res = parseManifest(
      manifest({ contributes: { panel: { title: 'P', icon: 'skull', entry: 'url' } } }),
      DIR,
    )
    expect(res.ok && res.manifest.contributes.panel).toEqual({ title: 'P', entry: 'url' })
  })
})

describe('parseManifest — workflows', () => {
  it('accepts workflows without a main process and validates each one', () => {
    const noMain = { id: 'demo', name: 'Demo', version: '1', api: '1.0' }
    const res = parseManifest(
      {
        ...noMain,
        contributes: {
          workflows: [
            {
              name: 'Tail logs',
              command: 'tail -f {{file}}',
              arguments: [{ name: 'file', default_value: 'app.log' }],
            },
          ],
        },
      },
      DIR,
    )
    if (!res.ok) throw new Error(res.error)
    expect(res.manifest.contributes.workflows).toEqual([
      {
        name: 'Tail logs',
        command: 'tail -f {{file}}',
        tags: [],
        arguments: [{ name: 'file', defaultValue: 'app.log' }],
      },
    ])
    const bad = parseManifest({ ...noMain, contributes: { workflows: [{ name: 'x' }] } }, DIR)
    expect(bad).toEqual({ ok: false, error: 'contributes.workflows[0]: missing command' })
    expect(parseManifest({ ...noMain, contributes: { workflows: {} } }, DIR).ok).toBe(false)
  })
})

describe('parseManifest — completions', () => {
  it('accepts a completion spec folder inside the extension without a main process', () => {
    const noMain = { id: 'specs', name: 'Specs', version: '1', api: '1.0' }
    const res = parseManifest({ ...noMain, contributes: { completions: 'specs' } }, DIR)
    if (!res.ok) throw new Error(res.error)
    expect(res.manifest.contributes.completions).toBe('specs')
    for (const completions of ['../elsewhere', '/abs/specs', '.', 3]) {
      expect(parseManifest({ ...noMain, contributes: { completions } }, DIR)).toEqual({
        ok: false,
        error: 'contributes.completions must be a folder inside the extension',
      })
    }
  })
})

describe('parseManifest — icon themes', () => {
  const noMain = { id: 'icons', name: 'Icons', version: '1', api: '1.0' }
  const theme = { id: 'material-icon-theme', label: 'Material', path: 'dist/theme.json' }

  it('accepts icon themes without a main process', () => {
    const res = parseManifest({ ...noMain, contributes: { iconThemes: [theme] } }, DIR)
    if (!res.ok) throw new Error(res.error)
    expect(res.manifest.contributes.iconThemes).toEqual([theme])
  })

  it('omits iconThemes when none are declared', () => {
    const res = parseManifest(noMain, DIR)
    if (!res.ok) throw new Error(res.error)
    expect(res.manifest.contributes.iconThemes).toBeUndefined()
  })

  it('rejects a theme path outside the extension or not a .json file', () => {
    for (const path of ['../theme.json', '/abs/theme.json', 'theme.js', 5]) {
      expect(
        parseManifest({ ...noMain, contributes: { iconThemes: [{ ...theme, path }] } }, DIR),
      ).toEqual({
        ok: false,
        error: 'contributes.iconThemes[0]: path must be a .json file inside the extension',
      })
    }
  })

  it('rejects bad ids, missing labels and duplicates', () => {
    const bad = (iconThemes: unknown) =>
      parseManifest({ ...noMain, contributes: { iconThemes } }, DIR)
    expect(bad([{ ...theme, id: '../x' }])).toEqual({
      ok: false,
      error: 'contributes.iconThemes[0]: invalid id',
    })
    expect(bad([{ ...theme, label: '' }])).toEqual({
      ok: false,
      error: 'contributes.iconThemes[0]: missing label',
    })
    expect(bad([theme, theme])).toEqual({
      ok: false,
      error: "contributes.iconThemes[1]: duplicate id 'material-icon-theme'",
    })
    expect(bad({})).toEqual({
      ok: false,
      error: 'contributes.iconThemes must be an array of at most 16',
    })
  })
})

describe('isInsideDir', () => {
  it('is true only for paths strictly below the directory', () => {
    expect(isInsideDir('/a/b', 'c.html')).toBe(true)
    expect(isInsideDir('/a/b', '/a/b/c/d.html')).toBe(true)
    expect(isInsideDir('/a/b', '/a/b')).toBe(false)
    expect(isInsideDir('/a/b', '/a/bc/d.html')).toBe(false)
    expect(isInsideDir('/a/b', '../b2/x')).toBe(false)
  })
})

describe('discoverExtensions', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
  })

  function root(exts: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), 'pine-ext-root-'))
    roots.push(dir)
    for (const [name, content] of Object.entries(exts)) {
      mkdirSync(join(dir, name))
      writeFileSync(
        join(dir, name, 'pine.json'),
        typeof content === 'string' ? content : JSON.stringify(content),
      )
    }
    return dir
  }

  it('finds valid extensions and reports broken ones without failing the rest', () => {
    const dir = root({
      good: manifest({ id: 'good' }),
      broken: '{ not json',
      invalid: { id: 'Bad Id', name: 'x', version: '1', api: '1.0' },
    })
    mkdirSync(join(dir, 'no-manifest'))
    const errors: string[] = []
    const found = discoverExtensions([{ dir, builtin: false }], (d) => errors.push(d))
    expect(found.map((f) => f.manifest.id)).toEqual(['good'])
    expect(found[0]).toMatchObject({ dir: join(dir, 'good'), builtin: false })
    expect(errors.sort()).toEqual([join(dir, 'broken'), join(dir, 'invalid')])
  })

  it('lets a built-in win when a user extension reuses its id', () => {
    const builtin = root({ git: manifest({ id: 'git', name: 'Builtin' }) })
    const user = root({ git: manifest({ id: 'git', name: 'Impostor' }) })
    const errors: string[] = []
    const found = discoverExtensions(
      [
        { dir: user, builtin: false },
        { dir: builtin, builtin: true },
      ],
      (_d, e) => errors.push(e),
    )
    expect(found).toHaveLength(1)
    expect(found[0].builtin).toBe(true)
    expect(found[0].manifest.name).toBe('Builtin')
    expect(errors).toEqual(["duplicate extension id 'git'"])
  })

  it('treats a missing root as empty', () => {
    expect(discoverExtensions([{ dir: '/nonexistent/pine-ext', builtin: false }])).toEqual([])
  })
})
