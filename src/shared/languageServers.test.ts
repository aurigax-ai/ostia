import { describe, expect, it } from 'vitest'
import {
  SERVER_JSON_MAX_BYTES,
  configurationSection,
  documentLanguageId,
  languageServerCommand,
  overlaySettings,
  parseLanguageServers,
  splitLanguageServerKey,
  substituteJson,
} from './languageServers'

const options = {
  isInside: (path: string) => !path.startsWith('..') && !path.startsWith('/'),
  capabilities: ['language-server'],
  settingKeys: ['mode'],
}

function server(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'demo',
    name: 'Demo',
    languages: ['python'],
    run: { node: 'server/main.js' },
    ...extra,
  }
}

function problem(extra: Record<string, unknown>, opts = options): string {
  const parsed = parseLanguageServers([server(extra)], opts)
  return typeof parsed === 'string' ? parsed : ''
}

describe('parseLanguageServers', () => {
  it('fills defaults for a bundled server and keeps a program server’s package', () => {
    expect(
      parseLanguageServers(
        [
          server(),
          {
            id: 'native',
            name: 'Native',
            languages: ['c', 'cpp', 'c'],
            run: { program: 'clangd', package: 'clang', args: ['--log=error'] },
            rootMarkers: ['compile_commands.json'],
          },
        ],
        options,
      ),
    ).toEqual([
      {
        id: 'demo',
        name: 'Demo',
        languages: ['python'],
        run: { node: 'server/main.js', args: [] },
        rootMarkers: [],
      },
      {
        id: 'native',
        name: 'Native',
        languages: ['c', 'cpp'],
        run: { program: 'clangd', package: 'clang', args: ['--log=error'] },
        rootMarkers: ['compile_commands.json'],
      },
    ])
  })

  it('needs the language-server capability, but not for an empty list', () => {
    const without = { ...options, capabilities: [] }
    expect(parseLanguageServers([server()], without)).toBe(
      "contributes.languageServers needs the 'language-server' capability",
    )
    expect(parseLanguageServers([], without)).toEqual([])
    expect(parseLanguageServers(undefined, without)).toEqual([])
  })

  it('allows at most eight servers with unique ids', () => {
    const nine = Array.from({ length: 9 }, (_, i) => server({ id: `s${i}` }))
    expect(parseLanguageServers(nine, options)).toMatch(/at most 8/)
    expect(parseLanguageServers([server(), server()], options)).toMatch(/duplicate id 'demo'/)
  })

  it('refuses a bad id, name or language list', () => {
    expect(problem({ id: 'Bad Id' })).toMatch(/invalid id/)
    expect(problem({ name: '' })).toMatch(/name must be 1-200 characters/)
    expect(problem({ name: 'x'.repeat(201) })).toMatch(/name must be/)
    expect(problem({ languages: [] })).toMatch(/1-16 editor language ids/)
    expect(problem({ languages: ['Python'] })).toMatch(/editor language ids/)
    expect(problem({ languages: Array.from({ length: 17 }, (_, i) => `l${i}`) })).toMatch(/1-16/)
  })

  it('takes exactly one run form: a script inside the extension or a bare program name', () => {
    expect(problem({ run: {} })).toMatch(/exactly one of node or program/)
    expect(problem({ run: { node: 'a.js', program: 'a' } })).toMatch(/exactly one/)
    expect(problem({ run: { node: '../outside.js' } })).toMatch(/inside the extension/)
    expect(problem({ run: { node: 'server.py' } })).toMatch(/\.js, \.mjs or \.cjs/)
    expect(problem({ run: { node: 'a.js', package: 'x' } })).toMatch(/package is not allowed/)
    expect(problem({ run: { program: '/usr/bin/clangd' } })).toMatch(/without a path/)
    expect(problem({ run: { program: 'a b' } })).toMatch(/without a path/)
    expect(problem({ run: { program: 'clangd', package: 'bad/name' } })).toMatch(/package name/)
    expect(problem({ run: { program: 'clangd', shell: true } })).toMatch(/shell is not allowed/)
    expect(problem({ run: { node: 'main.mjs' } })).toBe('')
    expect(problem({ run: { node: 'main.cjs' } })).toBe('')
  })

  it('limits arguments to 32 strings of 200 characters', () => {
    expect(problem({ run: { program: 'x', args: Array(33).fill('a') } })).toMatch(/at most 32/)
    expect(problem({ run: { program: 'x', args: ['a'.repeat(201)] } })).toMatch(/200 characters/)
    expect(problem({ run: { program: 'x', args: [1] } })).toMatch(/strings/)
  })

  it('takes root markers as plain file names', () => {
    expect(problem({ rootMarkers: ['a/b'] })).toMatch(/file names/)
    expect(problem({ rootMarkers: ['..'] })).toMatch(/file names/)
    expect(problem({ rootMarkers: Array.from({ length: 17 }, (_, i) => `m${i}`) })).toMatch(/16/)
    expect(problem({ rootMarkers: ['.git', 'go.mod'] })).toBe('')
  })

  it('maps editor language ids and file suffixes to document language ids', () => {
    expect(
      problem({ documentLanguageIds: { shell: 'shellscript', '.tsx': 'typescriptreact' } }),
    ).toBe('')
    expect(problem({ documentLanguageIds: { 'Not An Id': 'x' } })).toMatch(/editor language id/)
    expect(problem({ documentLanguageIds: { shell: 'has space' } })).toMatch(/language id/)
    expect(problem({ documentLanguageIds: [] })).toMatch(/must be an object/)
  })

  it('keeps initialization options and settings as JSON, without prototype keys, up to 16 KiB', () => {
    const parsed = parseLanguageServers(
      [
        server({
          initializationOptions: JSON.parse('{"a":{"__proto__":{"x":1},"b":[1,"two",null]}}'),
          settings: { python: { analysis: { mode: 'standard' } } },
        }),
      ],
      options,
    )
    expect(parsed).toMatchObject([
      {
        initializationOptions: { a: { b: [1, 'two', null] } },
        settings: { python: { analysis: { mode: 'standard' } } },
      },
    ])
    expect(problem({ settings: { big: 'x'.repeat(SERVER_JSON_MAX_BYTES) } })).toMatch(
      /larger than 16384 bytes/,
    )
    expect(problem({ initializationOptions: [] })).toMatch(/must be an object/)
  })

  it('maps only the extension’s own settings to dotted paths', () => {
    expect(problem({ settingPaths: { mode: 'python.analysis.mode' } })).toBe('')
    expect(problem({ settingPaths: { other: 'a.b' } })).toMatch(
      /not one of the extension's settings/,
    )
    expect(problem({ settingPaths: { mode: 'a..b' } })).toMatch(/dotted path/)
    expect(problem({ settingPaths: { mode: 'a.__proto__.b' } })).toMatch(/dotted path/)
  })
})

describe('language server helpers', () => {
  it('shows the command line a server runs', () => {
    expect(languageServerCommand({ program: 'gopls', args: ['serve'] })).toBe('gopls serve')
    expect(languageServerCommand({ node: 'server/cli.mjs', args: ['--stdio'] })).toBe(
      'server/cli.mjs --stdio',
    )
  })

  it('splits a server key into extension and server', () => {
    expect(splitLanguageServerKey('lsp-gopls/gopls')).toEqual({
      extId: 'lsp-gopls',
      serverId: 'gopls',
    })
    for (const bad of ['gopls', '/gopls', 'a/', 'a/b/c', 7, null]) {
      expect(splitLanguageServerKey(bad)).toBeNull()
    }
  })

  it('replaces the two placeholders in every string leaf', () => {
    expect(
      substituteJson(
        { a: '{extensionDir}/lib', b: ['{root}', 2, { c: '{root}/{root}' }], d: null },
        '/ext',
        '/work',
      ),
    ).toEqual({ a: '/ext/lib', b: ['/work', 2, { c: '/work//work' }], d: null })
  })

  it('lays the human’s values over the declared settings without touching the original', () => {
    const base = { python: { analysis: { mode: 'standard', depth: 1 } } }
    expect(
      overlaySettings(
        base,
        { mode: 'python.analysis.mode', lint: 'python.lint.on', unset: 'python.unset' },
        { mode: 'strict', lint: true },
      ),
    ).toEqual({ python: { analysis: { mode: 'strict', depth: 1 }, lint: { on: true } } })
    expect(base.python.analysis.mode).toBe('standard')
  })

  it('answers a configuration section by own properties only', () => {
    const settings = { python: { analysis: { mode: 'strict' } } }
    expect(configurationSection(settings, 'python.analysis')).toEqual({ mode: 'strict' })
    expect(configurationSection(settings, 'python.analysis.mode')).toBe('strict')
    expect(configurationSection(settings, undefined)).toBe(settings)
    expect(configurationSection(settings, '')).toBe(settings)
    expect(configurationSection(settings, 'python.missing')).toBeNull()
    expect(configurationSection(settings, 'python.constructor')).toBeNull()
    expect(configurationSection(settings, 'python.analysis.mode.length')).toBeNull()
  })

  it('names a document by file suffix first, then by editor language', () => {
    const ids = { documentLanguageIds: { typescript: 'typescript', '.tsx': 'typescriptreact' } }
    expect(documentLanguageId(ids, '/p/App.TSX', 'typescript')).toBe('typescriptreact')
    expect(documentLanguageId(ids, '/p/app.ts', 'typescript')).toBe('typescript')
    expect(
      documentLanguageId({ documentLanguageIds: { shell: 'shellscript' } }, '/p/a.sh', 'shell'),
    ).toBe('shellscript')
    expect(documentLanguageId({}, '/p/a.go', 'go')).toBe('go')
  })
})
