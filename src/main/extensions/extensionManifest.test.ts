import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_AGENT_HOOKS, MAX_AGENT_SKILLS, MAX_AGENT_SKILL_FILES } from '../../shared/agentPlugins'
import { EXTENSION_API_VERSION } from '../../shared/extensionApi'
import { discoverExtensions, parseManifest, readManifest } from './extensionManifest'

const DIR = '/ext/demo'

function manifest(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'demo', name: 'Demo', version: '1.0.0', api: '3.0', main: 'main.js', ...extra }
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
        api: '3.0',
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
          api: '3.0',
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
    const base = { id: 'lsp-demo', name: 'Demo', version: '1.0.0', api: '3.0' }
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
        error: `needs extension API ${api}; this ostia provides ${EXTENSION_API_VERSION}`,
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
      'keeper',
      'keymap-macos',
      'langpack-zh-hant',
      'lsp-bash',
      'lsp-clangd',
      'lsp-gopls',
      'lsp-lua',
      'lsp-marksman',
      'lsp-pyright',
      'lsp-rust-analyzer',
      'lsp-typescript',
      'lsp-yaml',
      'model-runtime',
      'system',
      'trellis',
    ]) {
      const dir = join(__dirname, '..', '..', 'extensions', id)
      const raw: unknown = JSON.parse(readFileSync(join(dir, 'ostia.json'), 'utf8'))
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
      api: '3.0',
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

  it('refuses the ids of the built-in git and ports features', () => {
    for (const id of ['git', 'ports']) {
      expect(parseManifest(manifest({ id }), DIR)).toEqual({
        ok: false,
        error: `id '${id}' is a built-in feature`,
      })
    }
    expect(parseManifest(manifest({ id: 'git-extras' }), DIR).ok).toBe(true)
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
      api: '3.0',
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
        api: '3.0',
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

describe('parseManifest — settings page', () => {
  const settings = { mode: { type: 'string', default: '', description: 'How it runs' } }
  const secrets = { token: { description: 'The token' } }
  const parse = (contributes: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    parseManifest(manifest({ contributes, ...extra }), DIR)

  it('keeps a title and an icon for an extension with settings or secrets', () => {
    const withSettings = parse({ settings, settingsPage: { title: 'Demo', icon: 'kanban' } })
    expect(withSettings.ok && withSettings.manifest.contributes.settingsPage).toEqual({
      title: 'Demo',
      icon: 'kanban',
    })
    const withSecrets = parse({ secrets, settingsPage: { title: 'Demo' } })
    expect(withSecrets.ok && withSecrets.manifest.contributes.settingsPage).toEqual({
      title: 'Demo',
    })
  })

  it('leaves the field out when the manifest has none', () => {
    const res = parse({ settings })
    expect(res.ok && res.manifest.contributes).not.toHaveProperty('settingsPage')
  })

  it('refuses a page with nothing to show', () => {
    expect(parse({ settingsPage: { title: 'Demo' } })).toEqual({
      ok: false,
      error: 'contributes.settingsPage needs contributes.settings or secrets',
    })
  })

  it('refuses a missing, long or multi-line title and an icon outside the list', () => {
    for (const settingsPage of [
      {},
      { title: '' },
      { title: 'x'.repeat(81) },
      { title: 'two\nlines' },
      { title: 'Demo', icon: 'skull' },
      'Demo',
      true,
    ]) {
      expect(parse({ settings, settingsPage }).ok, JSON.stringify(settingsPage)).toBe(false)
    }
  })

  it('refuses a page on an assist extension, whose settings live in Settings → Assistant', () => {
    const res = parse(
      { settings, assist: ['chat'], settingsPage: { title: 'Demo' } },
      { capabilities: ['assist'] },
    )
    expect(res.ok).toBe(false)
  })
})

describe('parseManifest — locales', () => {
  const locales = (list: unknown) => parseManifest(manifest({ locales: list }), DIR)

  it('keeps the language tags an extension translates itself into', () => {
    const res = locales(['zh-Hant', 'fr'])
    expect(res.ok && res.manifest.locales).toEqual(['zh-Hant', 'fr'])
  })

  it('leaves the field out when nothing is declared', () => {
    const res = parseManifest(manifest({}), DIR)
    expect(res.ok && 'locales' in res.manifest).toBe(false)
  })

  it('refuses anything that is not a list of distinct language tags', () => {
    const tag = 'locales: each entry must be a language tag such as fr or zh-Hant'
    expect(locales('zh-Hant')).toEqual({
      ok: false,
      error: 'locales must be an array of at most 32 language tags',
    })
    expect(locales(['../zh-Hant'])).toEqual({ ok: false, error: tag })
    expect(locales(['zh-Hant/x'])).toEqual({ ok: false, error: tag })
    expect(locales([7])).toEqual({ ok: false, error: tag })
    expect(locales(['zh-Hant', 'ZH-hant'])).toEqual({
      ok: false,
      error: "locales: duplicate 'ZH-hant'",
    })
    expect(
      locales(Array.from({ length: 33 }, (_, i) => `x${String.fromCharCode(97 + (i % 26))}-A${i}`))
        .ok,
    ).toBe(false)
  })
})

describe('parseManifest — workflows', () => {
  it('accepts workflows without a main process and validates each one', () => {
    const noMain = { id: 'demo', name: 'Demo', version: '1', api: '3.0' }
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
    const noMain = { id: 'specs', name: 'Specs', version: '1', api: '3.0' }
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
  const noMain = { id: 'icons', name: 'Icons', version: '1', api: '3.0' }
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

describe('parseManifest — keymaps', () => {
  const noMain = { id: 'keys', name: 'Keys', version: '1', api: '3.0' }
  const keymap = { id: 'cmux', label: 'macOS (cmux)', path: 'keymaps/cmux.json' }
  const keymaps = (list: unknown) =>
    parseManifest({ ...noMain, contributes: { keymaps: list } }, DIR)

  it('accepts keymaps without a main process or capabilities, keeping a platform', () => {
    const res = keymaps([keymap, { ...keymap, id: 'cmux-mac', platform: 'darwin' }])
    if (!res.ok) throw new Error(res.error)
    expect(res.manifest.main).toBeUndefined()
    expect(res.manifest.capabilities).toEqual([])
    expect(res.manifest.contributes.keymaps).toEqual([
      keymap,
      { ...keymap, id: 'cmux-mac', platform: 'darwin' },
    ])
  })

  it('omits keymaps when none are declared', () => {
    const res = parseManifest(noMain, DIR)
    if (!res.ok) throw new Error(res.error)
    expect(res.manifest.contributes.keymaps).toBeUndefined()
  })

  it('rejects a path outside the extension or not a .json file', () => {
    for (const path of [
      '../cmux.json',
      '/abs/cmux.json',
      'keymaps/../../cmux.json',
      'cmux.js',
      5,
    ]) {
      expect(keymaps([{ ...keymap, path }]), String(path)).toEqual({
        ok: false,
        error: 'contributes.keymaps[0]: path must be a .json file inside the extension',
      })
    }
  })

  it('rejects more than 8 keymaps or a list that is not an array', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ ...keymap, id: `k${i}` }))
    expect(keymaps(many.slice(0, 8)).ok).toBe(true)
    for (const list of [many, {}]) {
      expect(keymaps(list)).toEqual({
        ok: false,
        error: 'contributes.keymaps must be an array of at most 8',
      })
    }
  })

  it('rejects a duplicate id', () => {
    expect(keymaps([keymap, { ...keymap, label: 'Other' }])).toEqual({
      ok: false,
      error: "contributes.keymaps[1]: duplicate id 'cmux'",
    })
  })

  it('rejects a platform other than darwin or linux', () => {
    for (const platform of ['win32', 'macos', 'Darwin', '', null, 1]) {
      expect(keymaps([{ ...keymap, platform }]), String(platform)).toEqual({
        ok: false,
        error: 'contributes.keymaps[0]: platform must be one of darwin, linux',
      })
    }
    expect(keymaps([{ ...keymap, platform: 'linux' }]).ok).toBe(true)
  })

  it('rejects bad ids and labels that are empty or longer than 40 characters', () => {
    for (const id of ['Cmux', 'cmux.mac', '-cmux', '../x', '']) {
      expect(keymaps([{ ...keymap, id }]), id).toEqual({
        ok: false,
        error: 'contributes.keymaps[0]: id must be lowercase letters, digits and dashes',
      })
    }
    for (const label of ['', '   ', 'x'.repeat(41), 3]) {
      expect(keymaps([{ ...keymap, label }]), String(label)).toEqual({
        ok: false,
        error: 'contributes.keymaps[0]: label must be 1-40 characters',
      })
    }
    expect(keymaps([{ ...keymap, label: 'x'.repeat(40) }]).ok).toBe(true)
    expect(keymaps(['cmux'])).toEqual({
      ok: false,
      error: 'contributes.keymaps[0]: must be an object',
    })
  })
})

describe('parseManifest — agent skills and hooks', () => {
  const hookCommand = { id: 'on-hook', title: 'Hook', palette: false, stdin: true }
  const agentManifest = (contributes: Record<string, unknown>, capabilities = ['agent-plugin']) =>
    manifest({ capabilities, contributes: { commands: [hookCommand], ...contributes } })

  it('keeps declared skills and hooks that name the extension’s own stdin command', () => {
    const res = parseManifest(
      agentManifest({
        agentSkills: [{ name: 'review', path: 'skills/review', files: ['checklist.md'] }],
        agentHooks: [
          { event: 'SessionStart', command: 'on-hook' },
          { event: 'PreToolUse', command: 'on-hook' },
        ],
      }),
      DIR,
    )
    if (!res.ok) throw new Error(res.error)
    expect(res.manifest.contributes.agentSkills).toEqual([
      { name: 'review', path: 'skills/review', files: ['checklist.md'] },
    ])
    expect(res.manifest.contributes.agentHooks).toEqual([
      { event: 'SessionStart', command: 'on-hook' },
      { event: 'PreToolUse', command: 'on-hook' },
    ])
  })

  it('defaults a skill’s files to none beyond SKILL.md', () => {
    const res = parseManifest(
      agentManifest({ agentSkills: [{ name: 'r', path: 'skills/r' }] }),
      DIR,
    )
    expect(res.ok && res.manifest.contributes.agentSkills).toEqual([
      { name: 'r', path: 'skills/r', files: [] },
    ])
  })

  it('needs the agent-plugin capability for skills or hooks', () => {
    for (const contributes of [
      { agentSkills: [{ name: 'r', path: 'skills/r' }] },
      { agentHooks: [{ event: 'Stop', command: 'on-hook' }] },
    ]) {
      const res = parseManifest(agentManifest(contributes, ['notify']), DIR)
      expect(res).toEqual({ ok: false, error: expect.stringContaining("'agent-plugin'") })
    }
  })

  it.each([
    [{ name: 'Review', path: 'skills/r' }, 'name must be'],
    [{ name: 'r', path: '../outside' }, 'folder inside the extension'],
    [{ name: 'r', path: '/abs/skills' }, 'folder inside the extension'],
    [{ name: 'r', path: 'skills/r', files: ['../x.md'] }, 'files lists'],
    [{ name: 'r', path: 'skills/r', files: ['sub/x.md'] }, 'files lists'],
    [{ name: 'r', path: 'skills/r', files: ['run.sh'] }, 'files lists'],
    [{ name: 'r', path: 'skills/r', files: ['SKILL.md'] }, 'files lists'],
    [{ name: 'r', path: 'skills/r', files: ['a.md', 'a.md'] }, 'duplicate file'],
  ])('refuses the skill %j', (skill, error) => {
    const res = parseManifest(agentManifest({ agentSkills: [skill] }), DIR)
    expect(res).toEqual({ ok: false, error: expect.stringContaining(error) })
  })

  it('refuses two skills with one name', () => {
    const skill = { name: 'r', path: 'skills/r' }
    const res = parseManifest(agentManifest({ agentSkills: [skill, skill] }), DIR)
    expect(res).toEqual({ ok: false, error: expect.stringContaining("duplicate name 'r'") })
  })

  it.each([
    [{ event: 'Startup', command: 'on-hook' }, "unknown event 'Startup'"],
    [{ event: 'Stop', command: 'other-ext-command' }, "this extension's commands"],
    [{ event: 'Stop', command: 'echo "$HOME"' }, "this extension's commands"],
  ])('refuses the hook %j', (hook, error) => {
    const res = parseManifest(agentManifest({ agentHooks: [hook] }), DIR)
    expect(res).toEqual({ ok: false, error: expect.stringContaining(error) })
  })

  it.each([
    [{ id: 'on-hook', title: 'Hook' }],
    [{ id: 'on-hook', title: 'Hook', stdin: true, interactive: true }],
    [{ id: 'on-hook', title: 'Hook', stdin: true, capabilities: ['notify'] }],
  ])(
    'refuses a hook whose command %j does not read stdin, is interactive or needs caps',
    (command) => {
      const res = parseManifest(
        manifest({
          capabilities: ['agent-plugin', 'notify'],
          contributes: { commands: [command], agentHooks: [{ event: 'Stop', command: 'on-hook' }] },
        }),
        DIR,
      )
      expect(res).toEqual({ ok: false, error: expect.stringContaining('must read stdin') })
    },
  )

  it('accepts the most skills, files and hooks and refuses one more of each', () => {
    const skills = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ name: `skill-${i}`, path: `skills/s${i}` }))
    const files = (n: number) => Array.from({ length: n }, (_, i) => `f${i}.md`)
    const commands = Array.from({ length: 17 }, (_, i) => ({
      id: `on-hook-${i}`,
      title: 'Hook',
      palette: false,
      stdin: true,
    }))
    const hooks = (n: number) =>
      commands.slice(0, n).map((command) => ({ event: 'Stop', command: command.id }))
    const parse = (contributes: Record<string, unknown>) =>
      parseManifest(
        manifest({ capabilities: ['agent-plugin'], contributes: { commands, ...contributes } }),
        DIR,
      )

    expect(parse({ agentSkills: skills(MAX_AGENT_SKILLS) }).ok).toBe(true)
    expect(parse({ agentSkills: skills(MAX_AGENT_SKILLS + 1) })).toEqual({
      ok: false,
      error: `contributes.agentSkills must be an array of at most ${MAX_AGENT_SKILLS}`,
    })
    const withFiles = (n: number) => [{ name: 'r', path: 'skills/r', files: files(n) }]
    expect(parse({ agentSkills: withFiles(MAX_AGENT_SKILL_FILES) }).ok).toBe(true)
    expect(parse({ agentSkills: withFiles(MAX_AGENT_SKILL_FILES + 1) })).toEqual({
      ok: false,
      error: `contributes.agentSkills[0]: files must be an array of at most ${MAX_AGENT_SKILL_FILES} file names`,
    })
    expect(parse({ agentHooks: hooks(MAX_AGENT_HOOKS) }).ok).toBe(true)
    expect(parse({ agentHooks: hooks(MAX_AGENT_HOOKS + 1) })).toEqual({
      ok: false,
      error: `contributes.agentHooks must be an array of at most ${MAX_AGENT_HOOKS}`,
    })
  })

  it('refuses the same hook twice', () => {
    const hook = { event: 'Stop', command: 'on-hook' }
    const res = parseManifest(agentManifest({ agentHooks: [hook, hook] }), DIR)
    expect(res).toEqual({ ok: false, error: expect.stringContaining('duplicate hook') })
  })
})

describe('discoverExtensions', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
  })

  function root(exts: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), 'ostia-ext-root-'))
    roots.push(dir)
    for (const [name, content] of Object.entries(exts)) {
      mkdirSync(join(dir, name))
      writeFileSync(
        join(dir, name, 'ostia.json'),
        typeof content === 'string' ? content : JSON.stringify(content),
      )
    }
    return dir
  }

  it('finds valid extensions and reports broken ones without failing the rest', () => {
    const dir = root({
      good: manifest({ id: 'good' }),
      broken: '{ not json',
      invalid: { id: 'Bad Id', name: 'x', version: '1', api: '3.0' },
    })
    mkdirSync(join(dir, 'no-manifest'))
    const errors: string[] = []
    const found = discoverExtensions([{ dir, builtin: false }], (d) => errors.push(d))
    expect(found.map((f) => f.manifest.id)).toEqual(['good'])
    expect(found[0]).toMatchObject({ dir: join(dir, 'good'), builtin: false })
    expect(errors.sort()).toEqual([join(dir, 'broken'), join(dir, 'invalid')])
  })

  it('lets a built-in win when a user extension reuses its id', () => {
    const builtin = root({ system: manifest({ id: 'system', name: 'Builtin' }) })
    const user = root({ system: manifest({ id: 'system', name: 'Impostor' }) })
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
    expect(errors).toEqual(["duplicate extension id 'system'"])
  })

  it('treats a missing root as empty', () => {
    expect(discoverExtensions([{ dir: '/nonexistent/ostia-ext', builtin: false }])).toEqual([])
  })

  it('reports a broken ostia.json by its own name', () => {
    const dir = root({})
    mkdirSync(join(dir, 'broken'))
    writeFileSync(join(dir, 'broken', 'ostia.json'), '{ nope')
    const res = readManifest(join(dir, 'broken'))
    expect(res.ok).toBe(false)
    expect(res.ok ? '' : res.error).toMatch(/^unreadable ostia\.json: /)
  })
})
