import { describe, expect, it } from 'vitest'
import {
  SERVER_JSON_MAX_BYTES,
  configurationSection,
  documentLanguageId,
  downloadUrlProblem,
  languageServerCommand,
  languageServerSummary,
  overlaySettings,
  parseLanguageServerOverride,
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
    expect(problem({ run: {} })).toMatch(/exactly one of node, program, download or goInstall/)
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

describe('parseLanguageServers: servers the app fetches', () => {
  const asset = {
    url: 'https://github.com/owner/repo/releases/download/1.2.3/tool-linux.gz',
    sha256: 'a'.repeat(64),
    archive: 'gz',
    executable: 'tool',
  }
  const download = (
    extra: Record<string, unknown> = {},
    assetExtra: Record<string, unknown> = {},
  ) => ({
    run: {
      download: {
        program: 'tool',
        version: '1.2.3',
        assets: { 'linux-x64': { ...asset, ...assetExtra } },
        ...extra,
      },
    },
  })
  const goInstall = (extra: Record<string, unknown> = {}) => ({
    run: {
      goInstall: {
        module: 'golang.org/x/tools/gopls',
        version: 'v0.20.0',
        binary: 'gopls',
        ...extra,
      },
    },
  })

  it('takes a pinned, checksummed download per platform', () => {
    expect(parseLanguageServers([server(download())], options)).toMatchObject([
      {
        run: {
          download: { program: 'tool', version: '1.2.3', assets: { 'linux-x64': asset } },
          args: [],
        },
      },
    ])
    expect(problem(download({}, { archive: 'zip', executable: 'tool_1.2.3/bin/tool.exe' }))).toBe(
      '',
    )
  })

  it('refuses a download that is not https on an allowed host', () => {
    for (const url of [
      'http://github.com/o/r/tool.gz',
      'https://evil.example/tool.gz',
      'https://github.com.evil.example/tool.gz',
      'https://user:pw@github.com/o/r/tool.gz',
      'https://github.com:444/o/r/tool.gz',
      'https://github.com/o/r/../../tool.gz',
      'file:///etc/passwd',
      42,
    ]) {
      expect(problem(download({}, { url })), String(url)).toMatch(/assets\.linux-x64\.url/)
    }
    expect(downloadUrlProblem('https://objects.githubusercontent.com/a/b')).toBeNull()
    expect(downloadUrlProblem('https://release-assets.githubusercontent.com/a/b?x=1')).toBeNull()
  })

  it('needs a pinned version, a sha256, a known archive kind and platform', () => {
    expect(problem(download({ version: 'latest' }))).toMatch(/pinned version/)
    expect(problem(download({ version: 'LATEST' }))).toMatch(/pinned version/)
    expect(problem(download({ version: '' }))).toMatch(/pinned version/)
    expect(problem(download({}, { sha256: 'abc' }))).toMatch(/sha256 must be 64/)
    expect(problem(download({}, { sha256: 'A'.repeat(64) }))).toMatch(/sha256/)
    expect(problem(download({}, { sha256: undefined }))).toMatch(/sha256/)
    expect(problem(download({}, { archive: 'rar' }))).toMatch(/archive must be one of/)
    expect(problem(download({ assets: {} }))).toMatch(/at least one platform/)
    expect(problem(download({ assets: { 'solaris-x64': asset } }))).toMatch(
      /must be one of linux-x64/,
    )
    expect(problem(download({ program: '/usr/bin/tool' }))).toMatch(/program name/)
    expect(problem(download({ extra: 1 }))).toMatch(/extra is not allowed/)
    expect(problem(download({}, { run: 'sh' }))).toMatch(/run is not allowed/)
  })

  it('keeps the executable inside the download', () => {
    for (const executable of ['../tool', '/bin/sh', 'a/../../tool', 'bin\\tool', 'a/./tool', '']) {
      expect(problem(download({}, { archive: 'zip', executable })), executable).toMatch(
        /relative path inside the download/,
      )
    }
    expect(problem(download({}, { archive: 'gz', executable: 'bin/tool' }))).toMatch(
      /file name for a gz download/,
    )
    expect(problem(download({}, { archive: 'plain', executable: 'bin/tool' }))).toMatch(
      /file name for a plain download/,
    )
  })

  it('takes go install of a pinned module version and nothing that could be a flag', () => {
    expect(parseLanguageServers([server(goInstall())], options)).toMatchObject([
      {
        run: {
          goInstall: { module: 'golang.org/x/tools/gopls', version: 'v0.20.0', binary: 'gopls' },
        },
      },
    ])
    for (const module of [
      '-modfile=x',
      'golang.org/x/tools/gopls@latest',
      'golang.org/x/tools/gopls -ldflags=x',
      'Golang.org/x/tools/gopls',
      'gopls',
      './local',
      'golang.org',
      'golang.org/x/../y',
      'golang.org//x',
    ]) {
      expect(problem(goInstall({ module })), module).toMatch(/Go module path/)
    }
    for (const version of ['latest', 'master', 'v1.2', '1.2.3', 'v1.2.3-rc1', 'v1.2.3 -x', '']) {
      expect(problem(goInstall({ version })), version).toMatch(/pinned version such as/)
    }
    expect(problem(goInstall({ binary: 'bin/gopls' }))).toMatch(/program name/)
    expect(problem(goInstall({ args: ['-x'] }))).toMatch(/args is not allowed/)
    expect(problem({ run: { goInstall: goInstall().run.goInstall, program: 'gopls' } })).toMatch(
      /exactly one/,
    )
  })

  it('describes what a server runs and what the app would fetch for it', () => {
    const [native, go] = parseLanguageServers(
      [server(download()), server({ id: 'go', ...goInstall() })],
      options,
    ) as Parameters<typeof languageServerSummary>[0][]
    expect(languageServerSummary(native)).toMatchObject({
      command: 'tool',
      download: { program: 'tool', version: '1.2.3', host: 'github.com' },
    })
    expect(languageServerSummary(go)).toMatchObject({
      command: 'gopls',
      goInstall: { command: 'go install golang.org/x/tools/gopls@v0.20.0', binary: 'gopls' },
    })
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
  it('takes a program override only as an absolute path with an argument list', () => {
    expect(parseLanguageServerOverride({ path: '/opt/ls', args: ['--stdio'] })).toEqual({
      path: '/opt/ls',
      args: ['--stdio'],
    })
    expect(parseLanguageServerOverride({ path: 'C:\\tools\\ls.exe' })).toEqual({
      path: 'C:\\tools\\ls.exe',
      args: [],
    })
    expect(parseLanguageServerOverride({ path: './ls' })).toBe('not-absolute')
    expect(parseLanguageServerOverride({ path: '~/bin/ls' })).toBe('not-absolute')
    expect(parseLanguageServerOverride('/opt/ls --stdio')).toBe('not-absolute')
    expect(parseLanguageServerOverride({ path: '/opt/ls', args: '--stdio' })).toBe('bad-arguments')
    expect(parseLanguageServerOverride({ path: '/opt/ls', args: [''] })).toBe('bad-arguments')
    expect(
      parseLanguageServerOverride({ path: '/opt/ls', args: Array.from({ length: 33 }, () => 'x') }),
    ).toBe('bad-arguments')
  })
})
