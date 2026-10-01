import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MARKETPLACE_MANIFEST_FILE } from '../shared/marketplace'
import {
  EXTENSION_MAX_FILES,
  GitError,
  type GitRunner,
  Marketplace,
  marketplaceId,
  normalizeMarketplaceUrl,
  parseMarketplaceManifest,
  planCopy,
  runGit,
} from './marketplace'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'pine-marketplace-'))
  dirs.push(d)
  return d
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    stdio: 'ignore',
  })
}

function writeExtension(repo: string, path: string, manifest: Record<string, unknown>): void {
  const dir = join(repo, path)
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(join(dir, 'pine.json'), JSON.stringify(manifest))
  writeFileSync(join(dir, 'main.js'), `module.exports = '${manifest.version}'\n`)
  writeFileSync(join(dir, 'lib', 'helper.js'), '')
}

function commit(repo: string): void {
  git(repo, 'add', '-A')
  git(repo, 'commit', '-m', 'update')
}

function weather(version: string): Record<string, unknown> {
  return {
    id: 'weather',
    name: 'Weather',
    version,
    api: '1.0',
    description: 'Shows the weather',
    capabilities: ['notify'],
    main: 'main.js',
  }
}

function marketplaceRepo(): string {
  const repo = tmp()
  git(repo, 'init', '-b', 'main')
  writeExtension(repo, 'extensions/weather', weather('1.0.0'))
  writeFileSync(
    join(repo, MARKETPLACE_MANIFEST_FILE),
    JSON.stringify({
      name: 'Test marketplace',
      description: 'For tests',
      extensions: ['extensions/weather'],
    }),
  )
  commit(repo)
  return repo
}

interface Harness {
  marketplace: Marketplace
  extensionsDir: string
  recordsPath: string
  forgotten: string[]
  rescans: () => number
  reopen: () => Marketplace
}

function harness(
  opts: { builtinIds?: string[]; git?: GitRunner; locale?: () => string } = {},
): Harness {
  const data = tmp()
  const extensionsDir = join(data, 'extensions')
  mkdirSync(extensionsDir)
  const forgotten: string[] = []
  let rescans = 0
  const recordsPath = join(data, 'marketplaces.json')
  const open = (): Marketplace =>
    new Marketplace({
      recordsPath,
      clonesDir: join(data, 'marketplaces'),
      extensionsDir,
      builtinIds: () => opts.builtinIds ?? [],
      forget: (id) => forgotten.push(id),
      rescan: () => {
        rescans++
      },
      gitMissing: () => false,
      ...(opts.locale ? { locale: opts.locale } : {}),
      ...(opts.git ? { git: opts.git } : {}),
    })
  return {
    marketplace: open(),
    extensionsDir,
    recordsPath,
    forgotten,
    rescans: () => rescans,
    reopen: open,
  }
}

describe('normalizeMarketplaceUrl', () => {
  it('expands owner/repo to a GitHub https URL', () => {
    expect(normalizeMarketplaceUrl(' acme/pine-extensions ')).toBe(
      'https://github.com/acme/pine-extensions.git',
    )
  })

  it('keeps https, ssh and scp-style git URLs and absolute folders', () => {
    expect(normalizeMarketplaceUrl('https://example.com/a/b.git')).toBe(
      'https://example.com/a/b.git',
    )
    expect(normalizeMarketplaceUrl('ssh://git@example.com/a/b.git')).toBe(
      'ssh://git@example.com/a/b.git',
    )
    expect(normalizeMarketplaceUrl('git@github.com:acme/ext.git')).toBe(
      'git@github.com:acme/ext.git',
    )
    expect(normalizeMarketplaceUrl('/srv/marketplace')).toBe('/srv/marketplace')
  })

  it('refuses options, helper transports, plain http, credentials and whitespace', () => {
    for (const bad of [
      '',
      '--upload-pack=touch /tmp/x',
      'ext::sh -c id',
      'ext::id',
      'http://example.com/a.git',
      'file:///srv/marketplace',
      'https://user:token@example.com/a.git',
      'https://example.com/a b.git',
      'acme/ext\n--flag',
      42,
    ]) {
      expect(normalizeMarketplaceUrl(bad)).toBeNull()
    }
  })
})

describe('parseMarketplaceManifest', () => {
  it('accepts a name and a list of folders inside the repository', () => {
    expect(parseMarketplaceManifest({ name: 'Mine', extensions: ['a', 'tools/b', 'a'] })).toEqual({
      name: 'Mine',
      description: '',
      extensions: ['a', 'tools/b'],
    })
  })

  it('refuses a missing name and paths that leave the repository', () => {
    expect(typeof parseMarketplaceManifest({ extensions: [] })).toBe('string')
    expect(typeof parseMarketplaceManifest({ name: 'x', extensions: ['../out'] })).toBe('string')
    expect(typeof parseMarketplaceManifest({ name: 'x', extensions: ['/etc'] })).toBe('string')
    expect(typeof parseMarketplaceManifest({ name: 'x', extensions: ['.'] })).toBe('string')
    expect(typeof parseMarketplaceManifest({ name: 'x', extensions: 'a' })).toBe('string')
  })
})

describe('planCopy', () => {
  it('lists every regular file and skips the .git folder', () => {
    const dir = tmp()
    mkdirSync(join(dir, '.git'))
    writeFileSync(join(dir, '.git', 'HEAD'), '')
    mkdirSync(join(dir, 'lib'))
    writeFileSync(join(dir, 'pine.json'), '{}')
    writeFileSync(join(dir, 'lib', 'a.js'), '')
    const plan = planCopy(dir)
    expect(plan.ok && plan.files.sort()).toEqual(['lib/a.js', 'pine.json'])
  })

  it('refuses a folder that holds a symlink', () => {
    const dir = tmp()
    symlinkSync('/etc/passwd', join(dir, 'passwd'))
    expect(planCopy(dir)).toEqual({ ok: false, error: 'invalid-extension' })
  })

  it('takes an extension that ships a language server with thousands of small files', () => {
    const dir = tmp()
    mkdirSync(join(dir, 'server', 'stubs'), { recursive: true })
    for (let i = 0; i < 5500; i++) writeFileSync(join(dir, 'server', 'stubs', `s${i}.pyi`), '')
    const plan = planCopy(dir)
    expect(plan.ok && plan.files.length).toBe(5500)
  })

  it('refuses a folder with too many files', () => {
    const dir = tmp()
    for (let i = 0; i <= EXTENSION_MAX_FILES; i++) writeFileSync(join(dir, `f${i}`), '')
    expect(planCopy(dir)).toEqual({ ok: false, error: 'too-large' })
  })
})

describe('Marketplace', () => {
  it('adds a git repository and lists its extensions as available', async () => {
    const repo = marketplaceRepo()
    const h = harness()
    const res = await h.marketplace.add(repo)
    expect(res.ok).toBe(true)
    expect(res.state.marketplaces).toEqual([
      {
        id: marketplaceId(repo),
        url: repo,
        name: 'Test marketplace',
        description: 'For tests',
        problems: [],
        extensions: [
          {
            id: 'weather',
            name: 'Weather',
            version: '1.0.0',
            description: 'Shows the weather',
            category: 'other',
            capabilities: ['notify'],
            runsProcess: true,
            state: 'available',
          },
        ],
      },
    ])
  })

  it('remembers its marketplaces across restarts', async () => {
    const repo = marketplaceRepo()
    const h = harness()
    await h.marketplace.add(repo)
    expect(
      h
        .reopen()
        .state()
        .marketplaces.map((m) => m.name),
    ).toEqual(['Test marketplace'])
  })

  it('refuses a bad URL, a duplicate and a repository without a marketplace file', async () => {
    const repo = marketplaceRepo()
    const empty = tmp()
    git(empty, 'init', '-b', 'main')
    writeFileSync(join(empty, 'README.md'), 'hi')
    commit(empty)
    const h = harness()
    expect(await h.marketplace.add('ext::sh -c id')).toMatchObject({
      ok: false,
      error: 'invalid-url',
    })
    await h.marketplace.add(repo)
    expect(await h.marketplace.add(repo)).toMatchObject({ ok: false, error: 'already-added' })
    const res = await h.marketplace.add(empty)
    expect(res).toMatchObject({ ok: false, error: 'invalid-marketplace' })
    expect(res.state.marketplaces).toHaveLength(1)
  })

  it('passes the URL to git after -- with symlinks and submodules off', async () => {
    const calls: string[][] = []
    const h = harness({
      git: async (args) => {
        calls.push(args)
        throw new Error('offline')
      },
    })
    const res = await h.marketplace.add('acme/ext')
    expect(res).toMatchObject({ ok: false, error: 'clone-failed', detail: 'offline' })
    const args = calls[0] ?? []
    expect(args[0]).toBe('clone')
    expect(args).toContain('--no-recurse-submodules')
    expect(args).toContain('core.symlinks=false')
    expect(args.at(-3)).toBe('--')
    expect(args.at(-2)).toBe('https://github.com/acme/ext.git')
  })

  it('reports entries it cannot offer instead of dropping the marketplace', async () => {
    const repo = marketplaceRepo()
    writeExtension(repo, 'extensions/broken', { id: 'broken' })
    writeFileSync(
      join(repo, MARKETPLACE_MANIFEST_FILE),
      JSON.stringify({
        name: 'Test marketplace',
        extensions: ['extensions/weather', 'extensions/broken', 'extensions/missing'],
      }),
    )
    commit(repo)
    const h = harness()
    const { state } = await h.marketplace.add(repo)
    expect(state.marketplaces[0]?.extensions.map((e) => e.id)).toEqual(['weather'])
    expect(state.marketplaces[0]?.problems).toEqual([
      'extensions/broken: missing name',
      'extensions/missing: not a folder in the repository',
    ])
  })

  it('lists an extension in the language when it ships a catalog, and installs the catalog with it', async () => {
    const repo = marketplaceRepo()
    writeExtension(repo, 'extensions/weather', { ...weather('1.0.0'), locales: ['zh-Hant'] })
    mkdirSync(join(repo, 'extensions/weather/locales'))
    writeFileSync(
      join(repo, 'extensions/weather/locales/zh-Hant.json'),
      JSON.stringify({ manifest: { name: '天氣', description: '顯示天氣' } }),
    )
    commit(repo)
    let locale = 'zh-Hant'
    const h = harness({ locale: () => locale })
    const { state } = await h.marketplace.add(repo)
    expect(state.marketplaces[0]?.extensions[0]).toMatchObject({
      id: 'weather',
      name: '天氣',
      description: '顯示天氣',
    })
    locale = 'en'
    expect(h.marketplace.state().marketplaces[0]?.extensions[0]).toMatchObject({
      name: 'Weather',
      description: 'Shows the weather',
    })
    await h.marketplace.install(state.marketplaces[0]?.id, 'weather')
    expect(existsSync(join(h.extensionsDir, 'weather', 'locales', 'zh-Hant.json'))).toBe(true)
  })

  it('installs an extension into the extensions folder and asks the host to rescan', async () => {
    const repo = marketplaceRepo()
    const h = harness()
    const { state } = await h.marketplace.add(repo)
    const id = state.marketplaces[0]?.id
    const res = await h.marketplace.install(id, 'weather')
    expect(res.ok).toBe(true)
    expect(JSON.parse(readFileSync(join(h.extensionsDir, 'weather', 'pine.json'), 'utf8'))).toEqual(
      weather('1.0.0'),
    )
    expect(existsSync(join(h.extensionsDir, 'weather', 'lib', 'helper.js'))).toBe(true)
    expect(existsSync(join(h.extensionsDir, 'weather', '.git'))).toBe(false)
    expect(res.state.marketplaces[0]?.extensions[0]?.state).toBe('installed')
    expect(res.state.installed).toEqual(['weather'])
    expect(h.rescans()).toBe(1)
  })

  it('drops any earlier approval of the id on a fresh install', async () => {
    const repo = marketplaceRepo()
    const h = harness()
    const { state } = await h.marketplace.add(repo)
    await h.marketplace.install(state.marketplaces[0]?.id, 'weather')
    expect(h.forgotten).toEqual(['weather'])
  })

  it('offers an update after a refresh brings a new version, and keeps the approval', async () => {
    const repo = marketplaceRepo()
    const h = harness()
    const { state } = await h.marketplace.add(repo)
    const id = state.marketplaces[0]?.id
    await h.marketplace.install(id, 'weather')
    writeExtension(repo, 'extensions/weather', weather('1.1.0'))
    commit(repo)
    const refreshed = await h.marketplace.refresh(id)
    expect(refreshed.state.marketplaces[0]?.extensions[0]).toMatchObject({
      state: 'update',
      version: '1.1.0',
      installedVersion: '1.0.0',
    })
    const updated = await h.marketplace.install(id, 'weather')
    expect(updated.state.marketplaces[0]?.extensions[0]?.state).toBe('installed')
    expect(readFileSync(join(h.extensionsDir, 'weather', 'main.js'), 'utf8')).toContain('1.1.0')
    expect(h.forgotten).toEqual(['weather'])
  })

  it('keeps the downloaded copy when a refresh fails', async () => {
    const repo = marketplaceRepo()
    const h = harness()
    const { state } = await h.marketplace.add(repo)
    rmSync(repo, { recursive: true, force: true })
    const res = await h.marketplace.refresh(state.marketplaces[0]?.id)
    expect(res).toMatchObject({ ok: false, error: 'clone-failed' })
    expect(res.state.marketplaces[0]?.extensions.map((e) => e.id)).toEqual(['weather'])
  })

  it('never overwrites a built-in or an extension the human put there', async () => {
    const repo = marketplaceRepo()
    const builtin = harness({ builtinIds: ['weather'] })
    const added = await builtin.marketplace.add(repo)
    expect(added.state.marketplaces[0]?.extensions[0]?.state).toBe('conflict')
    expect(
      await builtin.marketplace.install(added.state.marketplaces[0]?.id, 'weather'),
    ).toMatchObject({ ok: false, error: 'conflict' })

    const manual = harness()
    mkdirSync(join(manual.extensionsDir, 'weather'))
    writeFileSync(join(manual.extensionsDir, 'weather', 'mine.txt'), 'keep')
    const { state } = await manual.marketplace.add(repo)
    expect(await manual.marketplace.install(state.marketplaces[0]?.id, 'weather')).toMatchObject({
      ok: false,
      error: 'conflict',
    })
    expect(readFileSync(join(manual.extensionsDir, 'weather', 'mine.txt'), 'utf8')).toBe('keep')
  })

  it('uninstalls only what it installed, and forgets its approval and secrets', async () => {
    const repo = marketplaceRepo()
    const h = harness()
    mkdirSync(join(h.extensionsDir, 'manual'))
    expect(await h.marketplace.uninstall('manual')).toMatchObject({
      ok: false,
      error: 'not-installed',
    })
    expect(existsSync(join(h.extensionsDir, 'manual'))).toBe(true)

    const { state } = await h.marketplace.add(repo)
    await h.marketplace.install(state.marketplaces[0]?.id, 'weather')
    h.forgotten.length = 0
    const res = await h.marketplace.uninstall('weather')
    expect(res.ok).toBe(true)
    expect(existsSync(join(h.extensionsDir, 'weather'))).toBe(false)
    expect(res.state.installed).toEqual([])
    expect(res.state.marketplaces[0]?.extensions[0]?.state).toBe('available')
    expect(h.forgotten).toEqual(['weather'])
  })

  it('removes a marketplace but leaves its installed extensions uninstallable', async () => {
    const repo = marketplaceRepo()
    const h = harness()
    const { state } = await h.marketplace.add(repo)
    const id = state.marketplaces[0]?.id
    await h.marketplace.install(id, 'weather')
    const res = await h.marketplace.remove(id)
    expect(res.state.marketplaces).toEqual([])
    expect(res.state.installed).toEqual(['weather'])
    expect(existsSync(join(h.extensionsDir, 'weather', 'pine.json'))).toBe(true)
    expect((await h.marketplace.uninstall('weather')).ok).toBe(true)
  })

  it('lists the editor languages each offered extension’s language servers cover', async () => {
    const repo = marketplaceRepo()
    writeExtension(repo, 'extensions/gleam', {
      id: 'gleam',
      name: 'Gleam',
      version: '1.0.0',
      api: '1.0',
      capabilities: ['language-server'],
      contributes: {
        languageServers: [
          { id: 'a', name: 'A', languages: ['gleam', 'toml'], run: { program: 'gleam' } },
          { id: 'b', name: 'B', languages: ['toml'], run: { program: 'taplo' } },
        ],
      },
    })
    writeFileSync(
      join(repo, MARKETPLACE_MANIFEST_FILE),
      JSON.stringify({ name: 'Test', extensions: ['extensions/weather', 'extensions/gleam'] }),
    )
    commit(repo)
    const h = harness()
    expect(h.marketplace.languageListings()).toEqual([])
    await h.marketplace.add(repo)
    const id = marketplaceId(repo)
    expect(h.marketplace.languageListings()).toEqual([
      { marketplaceId: id, extId: 'weather', name: 'Weather', languages: [] },
      { marketplaceId: id, extId: 'gleam', name: 'Gleam', languages: ['gleam', 'toml'] },
    ])
    await h.marketplace.remove(id)
    expect(h.marketplace.languageListings()).toEqual([])
  })

  it('installs a suggested extension from a marketplace that already lists it', async () => {
    const repo = marketplaceRepo()
    const clones: string[] = []
    const h = harness({
      git: async (args) => {
        clones.push(args[args.length - 2])
        await runGit(args)
      },
    })
    await h.marketplace.add(repo)
    const res = await h.marketplace.installSuggested('weather', 'aurigax-ai/pine-extensions', false)
    expect(res.ok).toBe(true)
    expect(existsSync(join(h.extensionsDir, 'weather', 'pine.json'))).toBe(true)
    expect(clones).toEqual([repo])
    expect(h.forgotten).toEqual(['weather'])
  })

  it('adds the official marketplace first when no marketplace lists the suggested extension', async () => {
    const official = marketplaceRepo()
    const cloned: string[] = []
    const h = harness({
      git: async (args) => {
        cloned.push(args[args.length - 2])
        await runGit([...args.slice(0, -2), official, args[args.length - 1]])
      },
    })
    const res = await h.marketplace.installSuggested('weather', 'aurigax-ai/pine-extensions', false)
    expect(res.ok).toBe(true)
    expect(cloned).toEqual(['https://github.com/aurigax-ai/pine-extensions.git'])
    expect(res.state.marketplaces.map((m) => m.url)).toEqual([
      'https://github.com/aurigax-ai/pine-extensions.git',
    ])
    expect(existsSync(join(h.extensionsDir, 'weather', 'pine.json'))).toBe(true)
  })

  it('takes an extension the app itself suggests only from the official marketplace', async () => {
    const squatter = marketplaceRepo()
    const official = tmp()
    git(official, 'init', '-b', 'main')
    writeExtension(official, 'extensions/weather', {
      ...weather('2.0.0'),
      name: 'Official weather',
    })
    writeFileSync(
      join(official, MARKETPLACE_MANIFEST_FILE),
      JSON.stringify({ name: 'Official', extensions: ['extensions/weather'] }),
    )
    commit(official)
    const h = harness({
      git: async (args) => {
        const url = args[args.length - 2]
        await runGit([
          ...args.slice(0, -2),
          url === squatter ? squatter : official,
          args[args.length - 1],
        ])
      },
    })
    await h.marketplace.add(squatter)
    const res = await h.marketplace.installSuggested('weather', 'aurigax-ai/pine-extensions', true)
    expect(res.ok).toBe(true)
    expect(res.state.marketplaces).toHaveLength(2)
    expect(
      JSON.parse(readFileSync(join(h.extensionsDir, 'weather', 'pine.json'), 'utf8')).name,
    ).toBe('Official weather')
  })

  it('installs nothing when the official marketplace does not have the extension or cannot be fetched', async () => {
    const official = marketplaceRepo()
    const h = harness({
      git: async (args) => runGit([...args.slice(0, -2), official, args[args.length - 1]]),
    })
    expect(
      await h.marketplace.installSuggested('nope', 'aurigax-ai/pine-extensions', false),
    ).toMatchObject({
      ok: false,
      error: 'unknown-extension',
    })
    expect(
      await h.marketplace.installSuggested('nope', 'aurigax-ai/pine-extensions', false),
    ).toMatchObject({
      ok: false,
      error: 'unknown-extension',
    })
    expect(
      await h.marketplace.installSuggested('../x', 'aurigax-ai/pine-extensions', false),
    ).toMatchObject({
      ok: false,
      error: 'unknown-extension',
    })
    const offline = harness({
      git: async () => {
        throw new GitError('clone-failed', 'could not resolve host')
      },
    })
    expect(
      await offline.marketplace.installSuggested('weather', 'aurigax-ai/pine-extensions', false),
    ).toMatchObject({ ok: false, error: 'clone-failed' })
    expect(readdirSync(offline.extensionsDir)).toEqual([])
  })
})
