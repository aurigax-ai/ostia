import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MARKETPLACE_CODE_PATTERN,
  MARKETPLACE_MANIFEST_FILE,
} from '@aurigax-ai/ostia-extension-sdk/manifest/marketplaceManifest'
import { afterEach, describe, expect, it } from 'vitest'
import { MARKETPLACE_CODE_SHAPE } from '../../../shared/extensions/marketplace'
import { Marketplace } from './marketplace'
import {
  GitError,
  type GitRunner,
  marketplaceId,
  normalizeMarketplaceUrl,
  runGit,
} from './marketplaceSources'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'ostia-marketplace-'))
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
  writeFileSync(join(dir, 'ostia.json'), JSON.stringify(manifest))
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
    api: '7.0',
    description: 'Shows the weather',
    capabilities: ['notify'],
    main: 'main.js',
  }
}

const CODE = 'abcdefghijklmnopqrstuvwx23'

function tides(version: string): Record<string, unknown> {
  return { id: 'tides', name: 'Tides', version, api: '7.0', main: 'main.js' }
}

function repoWithUnlisted(): string {
  const repo = marketplaceRepo()
  writeExtension(repo, 'extensions/tides', tides('1.0.0'))
  writeFileSync(
    join(repo, MARKETPLACE_MANIFEST_FILE),
    JSON.stringify({
      name: 'Test marketplace',
      extensions: ['extensions/weather'],
      unlisted: [{ path: 'extensions/tides', code: CODE }],
    }),
  )
  commit(repo)
  return repo
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
  opts: {
    builtinIds?: string[]
    git?: GitRunner
    locale?: () => string
    official?: string
    recordsText?: string
  } = {},
): Harness {
  const data = tmp()
  const extensionsDir = join(data, 'extensions')
  mkdirSync(extensionsDir)
  const forgotten: string[] = []
  let rescans = 0
  const recordsPath = join(data, 'marketplaces.json')
  if (opts.recordsText !== undefined) writeFileSync(recordsPath, opts.recordsText)
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
      ...(opts.official ? { official: opts.official } : {}),
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
    expect(normalizeMarketplaceUrl(' acme/extensions ')).toBe(
      'https://github.com/acme/extensions.git',
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

describe('Marketplace', () => {
  const OFFICIAL_URL = 'https://github.com/aurigax-ai/ostia-extensions.git'

  it('lists the official marketplace on a fresh install without downloading it', () => {
    const cloned: string[][] = []
    const h = harness({
      official: 'aurigax-ai/ostia-extensions',
      git: async (args) => {
        cloned.push(args)
      },
    })
    expect(h.marketplace.state().marketplaces).toEqual([
      expect.objectContaining({
        url: OFFICIAL_URL,
        official: true,
        downloaded: false,
        extensions: [],
      }),
    ])
    expect(h.marketplace.state().marketplaces[0]).not.toHaveProperty('error')
    expect(cloned).toEqual([])
    expect(existsSync(h.recordsPath)).toBe(false)
  })

  it('downloads the default official marketplace on the human’s refresh', async () => {
    const official = marketplaceRepo()
    const h = harness({
      official: 'aurigax-ai/ostia-extensions',
      git: async (args) => runGit([...args.slice(0, -2), official, args[args.length - 1]]),
    })
    const [listed] = h.marketplace.state().marketplaces
    const res = await h.marketplace.refresh(listed?.id)
    expect(res.state.marketplaces[0]).toMatchObject({ downloaded: true, official: true })
    expect(res.state.marketplaces[0]?.extensions.map((e) => e.id)).toEqual(['weather'])
  })

  it('refuses to remove the official marketplace', async () => {
    const h = harness({ official: 'aurigax-ai/ostia-extensions' })
    const [listed] = h.marketplace.state().marketplaces
    const res = await h.marketplace.remove(listed?.id, false)
    expect(res).toMatchObject({ ok: false, error: 'official-marketplace' })
    expect(
      h
        .reopen()
        .state()
        .marketplaces.map((m) => m.url),
    ).toEqual([OFFICIAL_URL])
  })

  it('lists the official marketplace first on an install that already keeps a list, and after it was removed by hand', () => {
    const h = harness({
      official: 'aurigax-ai/ostia-extensions',
      recordsText: JSON.stringify({ sources: [{ url: 'acme/ext' }], installs: {} }),
    })
    expect(h.marketplace.state().marketplaces.map((m) => [m.url, m.official])).toEqual([
      [OFFICIAL_URL, true],
      ['https://github.com/acme/ext.git', false],
    ])
  })

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
        installs: [],
        unlisted: false,
        official: false,
        downloaded: true,
        extensions: [
          {
            id: 'weather',
            name: 'Weather',
            version: '1.0.0',
            description: 'Shows the weather',
            category: 'other',
            capabilities: ['notify'],
            runsProcess: true,
            agentSkills: [],
            agentHooks: [],
            state: 'available',
          },
        ],
      },
    ])
  })

  it('describes the icon, agent skills and hooks an offered extension declares', async () => {
    const repo = marketplaceRepo()
    writeExtension(repo, 'extensions/weather', {
      ...weather('1.0.0'),
      capabilities: ['notify', 'agent-plugin'],
      contributes: {
        commands: [{ id: 'note', title: 'Note the prompt', stdin: true, palette: false }],
        panel: { title: 'Weather', icon: 'globe', entry: 'panel.html' },
        agentSkills: [{ name: 'forecast', path: 'skills/forecast' }],
        agentHooks: [{ event: 'UserPromptSubmit', command: 'note' }],
      },
    })
    mkdirSync(join(repo, 'extensions/weather/skills/forecast'), { recursive: true })
    writeFileSync(
      join(repo, 'extensions/weather/skills/forecast/SKILL.md'),
      '---\nname: forecast\ndescription: Reads the forecast\n---\nBody\n',
    )
    writeFileSync(join(repo, 'extensions/weather/panel.html'), '')
    commit(repo)
    const h = harness()
    const res = await h.marketplace.add(repo)
    expect(res.state.marketplaces[0]?.extensions[0]).toMatchObject({
      icon: 'globe',
      agentSkills: ['forecast'],
      agentHooks: [{ event: 'UserPromptSubmit', command: 'Note the prompt' }],
    })
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

  it('refuses an extension whose agent skill carries a directive and shows why', async () => {
    const repo = marketplaceRepo()
    writeExtension(repo, 'extensions/weather', {
      ...weather('1.0.0'),
      capabilities: ['agent-plugin'],
      contributes: { agentSkills: [{ name: 'forecast', path: 'skills/forecast' }] },
    })
    mkdirSync(join(repo, 'extensions/weather/skills/forecast'), { recursive: true })
    writeFileSync(
      join(repo, 'extensions/weather/skills/forecast/SKILL.md'),
      '---\nname: forecast\ndescription: Reads the forecast\nallowed-tools: Bash(*)\n---\nBody\n',
    )
    commit(repo)
    const h = harness()
    const { state } = await h.marketplace.add(repo)
    expect(state.marketplaces[0]?.extensions).toEqual([])
    expect(state.marketplaces[0]?.problems).toEqual([
      "extensions/weather: agent skill 'forecast': SKILL.md: line 4: 'allowed-tools' is not allowed, a skill carries only name and description",
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
    expect(
      JSON.parse(readFileSync(join(h.extensionsDir, 'weather', 'ostia.json'), 'utf8')),
    ).toEqual(weather('1.0.0'))
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
    const res = await h.marketplace.remove(id, false)
    expect(res.state.marketplaces).toEqual([])
    expect(res.state.installed).toEqual(['weather'])
    expect(existsSync(join(h.extensionsDir, 'weather', 'ostia.json'))).toBe(true)
    expect((await h.marketplace.uninstall('weather')).ok).toBe(true)
  })

  it('lists what a marketplace installed and uninstalls it with the marketplace when asked', async () => {
    const repo = marketplaceRepo()
    const h = harness()
    const id = marketplaceId(repo)
    await h.marketplace.add(repo)
    const installed = await h.marketplace.install(id, 'weather')
    expect(installed.state.marketplaces[0]?.installs).toEqual(['weather'])
    h.forgotten.length = 0

    const res = await h.marketplace.remove(id, true)

    expect(res.ok).toBe(true)
    expect(res.state.marketplaces).toEqual([])
    expect(res.state.installed).toEqual([])
    expect(existsSync(join(h.extensionsDir, 'weather'))).toBe(false)
    expect(h.forgotten).toEqual(['weather'])
  })

  it('offers to replace an extension whose marketplace was removed, and replaces it pending approval', async () => {
    const before = marketplaceRepo()
    const after = marketplaceRepo()
    writeExtension(after, 'extensions/weather', weather('1.1.0'))
    commit(after)
    const h = harness()
    await h.marketplace.add(before)
    await h.marketplace.install(marketplaceId(before), 'weather')
    await h.marketplace.remove(marketplaceId(before), false)
    const added = await h.marketplace.add(after)
    expect(added.state.marketplaces[0]?.extensions[0]?.state).toBe('replace')
    h.forgotten.length = 0

    const res = await h.marketplace.install(marketplaceId(after), 'weather')

    expect(res.ok).toBe(true)
    expect(h.forgotten).toEqual(['weather'])
    expect(res.state.marketplaces[0]?.extensions[0]?.state).toBe('installed')
    expect(res.state.marketplaces[0]?.installs).toEqual(['weather'])
    expect(readFileSync(join(h.extensionsDir, 'weather', 'main.js'), 'utf8')).toContain('1.1.0')
  })

  it('keeps an extension another added marketplace installed out of reach', async () => {
    const first = marketplaceRepo()
    const second = marketplaceRepo()
    const h = harness()
    await h.marketplace.add(first)
    await h.marketplace.add(second)
    await h.marketplace.install(marketplaceId(first), 'weather')

    const res = await h.marketplace.install(marketplaceId(second), 'weather')

    expect(res).toMatchObject({ ok: false, error: 'conflict' })
    const offered = res.state.marketplaces.find((m) => m.id === marketplaceId(second))
    expect(offered?.extensions[0]?.state).toBe('conflict')
  })

  it('lists the languages and file patterns each offered extension covers', async () => {
    const repo = marketplaceRepo()
    writeExtension(repo, 'extensions/gleam', {
      id: 'gleam',
      name: 'Gleam',
      version: '1.0.0',
      api: '7.0',
      capabilities: ['language-server', 'file-contents'],
      main: 'main.js',
      contributes: {
        languageServers: [
          { id: 'a', name: 'A', languages: ['gleam', 'toml'], run: { program: 'gleam' } },
          { id: 'b', name: 'B', languages: ['toml'], run: { program: 'taplo' } },
        ],
        fileKinds: [
          {
            id: 'gleam.pkg',
            displayName: 'Package',
            selector: [{ filenamePattern: '*.gleam' }],
            view: { entry: 'pkg.html' },
          },
          {
            id: 'gleam.zip',
            displayName: 'Bundle',
            selector: [{ filenamePattern: '*.gleamz' }],
            browse: {},
          },
        ],
      },
    })
    writeFileSync(
      join(repo, MARKETPLACE_MANIFEST_FILE),
      JSON.stringify({ name: 'Test', extensions: ['extensions/weather', 'extensions/gleam'] }),
    )
    commit(repo)
    const h = harness()
    expect(h.marketplace.listings()).toEqual([])
    await h.marketplace.add(repo)
    const id = marketplaceId(repo)
    expect(h.marketplace.listings()).toEqual([
      {
        marketplaceId: id,
        extId: 'weather',
        name: 'Weather',
        languages: [],
        patterns: [],
        browsePatterns: [],
      },
      {
        marketplaceId: id,
        extId: 'gleam',
        name: 'Gleam',
        languages: ['gleam', 'toml'],
        patterns: ['*.gleam'],
        browsePatterns: ['*.gleamz'],
      },
    ])
    await h.marketplace.remove(id, false)
    expect(h.marketplace.listings()).toEqual([])
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
    const res = await h.marketplace.installSuggested(
      'weather',
      'aurigax-ai/ostia-extensions',
      false,
    )
    expect(res.ok).toBe(true)
    expect(existsSync(join(h.extensionsDir, 'weather', 'ostia.json'))).toBe(true)
    expect(clones).toEqual([repo])
    expect(h.forgotten).toEqual(['weather'])
  })

  it('says a suggested extension is held elsewhere instead of calling it unlisted', async () => {
    const first = marketplaceRepo()
    const second = marketplaceRepo()
    const h = harness()
    await h.marketplace.add(first)
    await h.marketplace.add(second)
    await h.marketplace.install(marketplaceId(first), 'weather')
    await h.marketplace.refresh(marketplaceId(first))

    const res = await h.marketplace.installSuggested('weather', second, true)

    expect(res).toMatchObject({ ok: false, error: 'conflict' })
  })

  it('replaces a suggested extension whose marketplace was removed', async () => {
    const gone = marketplaceRepo()
    const official = marketplaceRepo()
    const h = harness()
    await h.marketplace.add(gone)
    await h.marketplace.install(marketplaceId(gone), 'weather')
    await h.marketplace.remove(marketplaceId(gone), false)
    await h.marketplace.add(official)
    h.forgotten.length = 0

    const res = await h.marketplace.installSuggested('weather', official, true)

    expect(res.ok).toBe(true)
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
    const res = await h.marketplace.installSuggested(
      'weather',
      'aurigax-ai/ostia-extensions',
      false,
    )
    expect(res.ok).toBe(true)
    expect(cloned).toEqual(['https://github.com/aurigax-ai/ostia-extensions.git'])
    expect(res.state.marketplaces.map((m) => m.url)).toEqual([
      'https://github.com/aurigax-ai/ostia-extensions.git',
    ])
    expect(existsSync(join(h.extensionsDir, 'weather', 'ostia.json'))).toBe(true)
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
    const res = await h.marketplace.installSuggested('weather', 'aurigax-ai/ostia-extensions', true)
    expect(res.ok).toBe(true)
    expect(res.state.marketplaces).toHaveLength(2)
    expect(
      JSON.parse(readFileSync(join(h.extensionsDir, 'weather', 'ostia.json'), 'utf8')).name,
    ).toBe('Official weather')
  })

  it('downloads the listed but not yet downloaded official marketplace for a suggested extension', async () => {
    const official = marketplaceRepo()
    const h = harness({
      official: 'aurigax-ai/ostia-extensions',
      git: async (args) => runGit([...args.slice(0, -2), official, args[args.length - 1]]),
    })
    const res = await h.marketplace.installSuggested('weather', 'aurigax-ai/ostia-extensions', true)
    expect(res.ok).toBe(true)
    expect(res.state.marketplaces).toHaveLength(1)
    expect(existsSync(join(h.extensionsDir, 'weather', 'ostia.json'))).toBe(true)
  })

  it('installs nothing when the official marketplace does not have the extension or cannot be fetched', async () => {
    const official = marketplaceRepo()
    const h = harness({
      git: async (args) => runGit([...args.slice(0, -2), official, args[args.length - 1]]),
    })
    expect(
      await h.marketplace.installSuggested('nope', 'aurigax-ai/ostia-extensions', false),
    ).toMatchObject({
      ok: false,
      error: 'unknown-extension',
    })
    expect(
      await h.marketplace.installSuggested('nope', 'aurigax-ai/ostia-extensions', false),
    ).toMatchObject({
      ok: false,
      error: 'unknown-extension',
    })
    expect(
      await h.marketplace.installSuggested('../x', 'aurigax-ai/ostia-extensions', false),
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
      await offline.marketplace.installSuggested('weather', 'aurigax-ai/ostia-extensions', false),
    ).toMatchObject({ ok: false, error: 'clone-failed' })
    expect(readdirSync(offline.extensionsDir)).toEqual([])
  })

  it('never sends an unlisted extension to the window, only that the marketplace has some', async () => {
    const h = harness()
    const { state } = await h.marketplace.add(repoWithUnlisted())
    expect(state.marketplaces[0]?.unlisted).toBe(true)
    expect(state.marketplaces[0]?.extensions.map((e) => e.id)).toEqual(['weather'])
    expect(JSON.stringify(state)).not.toContain('tides')
  })

  it('does not report a broken unlisted entry among the problems it shows', async () => {
    const repo = repoWithUnlisted()
    writeFileSync(join(repo, 'extensions/tides/ostia.json'), '{}')
    commit(repo)
    const h = harness()
    const { state } = await h.marketplace.add(repo)
    expect(state.marketplaces[0]?.problems).toEqual([])
    const res = await h.marketplace.installCode(state.marketplaces[0]?.id, CODE)
    expect(res).toMatchObject({ ok: false, error: 'invalid-extension' })
  })

  it('installs an unlisted extension only by its exact code, never by its id', async () => {
    const h = harness()
    const { state } = await h.marketplace.add(repoWithUnlisted())
    const id = state.marketplaces[0]?.id
    expect(await h.marketplace.install(id, 'tides')).toMatchObject({
      ok: false,
      error: 'unknown-extension',
    })
    for (const wrong of ['tides', CODE.slice(0, 25), `${CODE.slice(0, 25)}a`, 42, '']) {
      expect(await h.marketplace.installCode(id, wrong)).toMatchObject({
        ok: false,
        error: 'unknown-code',
      })
    }
    expect(existsSync(join(h.extensionsDir, 'tides'))).toBe(false)
    const res = await h.marketplace.installCode(id, ` ${CODE} `)
    expect(res.ok).toBe(true)
    expect(JSON.parse(readFileSync(join(h.extensionsDir, 'tides', 'ostia.json'), 'utf8'))).toEqual(
      tides('1.0.0'),
    )
    expect(h.forgotten).toEqual(['tides'])
    expect(res.state.installed).toEqual(['tides'])
  })

  it('keeps the renderer’s code shape the same as the manifest’s code pattern', () => {
    expect(MARKETPLACE_CODE_SHAPE.source).toBe(MARKETPLACE_CODE_PATTERN.source)
  })

  it('finds an unlisted extension by its exact code without installing it', async () => {
    const h = harness()
    const { state } = await h.marketplace.add(repoWithUnlisted())
    const id = state.marketplaces[0]?.id
    for (const wrong of ['tides', CODE.slice(0, 25), `${CODE.slice(0, 25)}a`, 42, '']) {
      expect(h.marketplace.findCode(wrong)).toEqual({ ok: false, error: 'unknown-code' })
    }
    const found = h.marketplace.findCode(` ${CODE} `)
    expect(found).toMatchObject({
      ok: true,
      marketplaceId: id,
      extension: { id: 'tides', state: 'available' },
    })
    expect(existsSync(join(h.extensionsDir, 'tides'))).toBe(false)
    expect(h.forgotten).toEqual([])
  })

  it('shows an unlisted extension once it is installed, and updates it like any other', async () => {
    const repo = repoWithUnlisted()
    const h = harness()
    const { state } = await h.marketplace.add(repo)
    const id = state.marketplaces[0]?.id
    const installed = await h.marketplace.installCode(id, CODE)
    expect(installed.state.marketplaces[0]?.extensions.map((e) => [e.id, e.state])).toEqual([
      ['weather', 'available'],
      ['tides', 'installed'],
    ])
    writeExtension(repo, 'extensions/tides', tides('1.1.0'))
    commit(repo)
    await h.marketplace.refresh(id)
    const updated = await h.marketplace.install(id, 'tides')
    expect(updated.ok).toBe(true)
    expect(readFileSync(join(h.extensionsDir, 'tides', 'main.js'), 'utf8')).toContain('1.1.0')
    const removed = await h.marketplace.uninstall('tides')
    expect(removed.state.marketplaces[0]?.extensions.map((e) => e.id)).toEqual(['weather'])
  })

  it('keeps an unlisted extension out of the language listings and the suggested install', async () => {
    const h = harness()
    const { state } = await h.marketplace.add(repoWithUnlisted())
    expect(h.marketplace.listings().map((l) => l.extId)).toEqual(['weather'])
    const url = state.marketplaces[0]?.url ?? ''
    expect(await h.marketplace.installSuggested('tides', url, true)).toMatchObject({
      ok: false,
      error: 'unknown-extension',
    })
    expect(existsSync(join(h.extensionsDir, 'tides'))).toBe(false)
  })

  it('an unlisted extension stays out of Settings until its install code is typed', async () => {
    const repo = repoWithUnlisted()
    writeFileSync(
      join(repo, MARKETPLACE_MANIFEST_FILE),
      JSON.stringify({
        name: 'Test marketplace',
        extensions: [],
        unlisted: [{ path: 'extensions/tides', code: CODE }],
      }),
    )
    commit(repo)
    const h = harness()
    const { state } = await h.marketplace.add(repo)
    const id = state.marketplaces[0]?.id
    expect(state.marketplaces[0]).toMatchObject({ unlisted: true, extensions: [] })
    const before = h.rescans()
    expect(await h.marketplace.installCode(id, 'hello')).toMatchObject({
      ok: false,
      error: 'unknown-code',
    })
    expect(existsSync(join(h.extensionsDir, 'tides', 'ostia.json'))).toBe(false)
    expect(h.rescans()).toBe(before)
    const res = await h.marketplace.installCode(id, CODE)
    expect(res.ok).toBe(true)
    expect(existsSync(join(h.extensionsDir, 'tides', 'ostia.json'))).toBe(true)
    expect(h.forgotten).toEqual(['tides'])
    expect(h.rescans()).toBe(before + 1)
    expect(res.state.marketplaces[0]?.extensions.map((e) => [e.id, e.state])).toEqual([
      ['tides', 'installed'],
    ])
  })
})
