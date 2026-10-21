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
import type { ExtensionManifest } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import {
  OFFICIAL_UPDATE_PENDING,
  type OfficialUpdateCheck,
} from '@aurigax-ai/ostia-extension-sdk/manifest/extensionManifest'
import {
  MARKETPLACE_CODE_PATTERN,
  MARKETPLACE_MANIFEST_FILE,
  type RevokedVersion,
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
  revocations: RevokedVersion[][]
  disabled: string[]
  reopen: () => Marketplace
}

function harness(
  opts: {
    bundled?: Record<string, string>
    officialUpdate?: OfficialUpdateCheck
    verified?: () => Promise<void>
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
  const saved: RevokedVersion[][] = []
  const disabled: string[] = []
  const recordsPath = join(data, 'marketplaces.json')
  if (opts.recordsText !== undefined) writeFileSync(recordsPath, opts.recordsText)
  const open = (): Marketplace =>
    new Marketplace({
      recordsPath,
      clonesDir: join(data, 'marketplaces'),
      extensionsDir,
      bundled: (id) =>
        opts.bundled?.[id] ? ({ id, version: opts.bundled[id] } as ExtensionManifest) : undefined,
      disable: (id) => disabled.push(id),
      verified: opts.verified ?? (async () => {}),
      officialUpdate: opts.officialUpdate ?? (() => 'unsigned'),
      saveRevocations: (revoked) => {
        saved.push([...revoked])
        return true
      },
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
    revocations: saved,
    disabled,
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
    const builtin = harness({ bundled: { weather: '1.0.0' } })
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

function publish(repo: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(
    join(repo, MARKETPLACE_MANIFEST_FILE),
    JSON.stringify({ name: 'Test marketplace', extensions: ['extensions/weather'], ...extra }),
  )
  commit(repo)
}

function release(repo: string, path: string, version: string, api = '7.0'): void {
  writeExtension(repo, path, { ...weather(version), api })
}

async function offered(h: Harness, repo: string) {
  const official = h.marketplace.state().marketplaces.find((m) => m.official)
  const { state } = official
    ? await h.marketplace.refresh(official.id)
    : await h.marketplace.add(repo)
  return { id: state.marketplaces[0]?.id, extension: state.marketplaces[0]?.extensions[0] }
}

describe('Marketplace releases', () => {
  function history(): string {
    const repo = marketplaceRepo()
    release(repo, 'extensions/weather', '2.0.0', '99.0')
    release(repo, 'versions/weather/1.5.0', '1.5.0', '7.0')
    release(repo, 'versions/weather/1.0.0', '1.0.0', '7.0')
    publish(repo, { history: ['versions/weather/1.5.0', 'versions/weather/1.0.0'] })
    return repo
  }

  it('offers the newest release this app accepts when the newest needs a newer one', async () => {
    const h = harness()
    const { id, extension } = await offered(h, history())
    expect(extension).toMatchObject({ version: '1.5.0', state: 'available' })
    expect(extension?.needsApi).toBeUndefined()
    await h.marketplace.install(id, 'weather')
    expect(
      JSON.parse(readFileSync(join(h.extensionsDir, 'weather', 'ostia.json'), 'utf8')).version,
    ).toBe('1.5.0')
  })

  it('shows an entry no release of fits as needing a newer app, and refuses to install it', async () => {
    const repo = marketplaceRepo()
    release(repo, 'extensions/weather', '2.0.0', '99.3')
    release(repo, 'versions/weather/1.9.0', '1.9.0', '99.1')
    publish(repo, { history: ['versions/weather/1.9.0'] })
    const h = harness()
    const { id, extension } = await offered(h, repo)
    expect(extension).toMatchObject({ state: 'incompatible', needsApi: '99.1' })
    expect(await h.marketplace.install(id, 'weather')).toMatchObject({
      ok: false,
      error: 'needs-newer-app',
    })
    expect(existsSync(join(h.extensionsDir, 'weather'))).toBe(false)
  })

  it('does not suggest an extension that needs a newer app', async () => {
    const repo = marketplaceRepo()
    release(repo, 'extensions/weather', '2.0.0', '99.0')
    publish(repo)
    const h = harness()
    await offered(h, repo)
    expect(h.marketplace.listings()).toEqual([])
  })

  it('offers an update only for a newer version, never for a downgrade', async () => {
    const repo = marketplaceRepo()
    release(repo, 'extensions/weather', '1.2.0')
    publish(repo)
    const h = harness()
    const { id } = await offered(h, repo)
    await h.marketplace.install(id, 'weather')
    release(repo, 'extensions/weather', '1.1.0')
    publish(repo)
    const refreshed = await h.marketplace.refresh(id)
    expect(refreshed.state.marketplaces[0]?.extensions[0]).toMatchObject({
      version: '1.1.0',
      state: 'installed',
    })
    release(repo, 'extensions/weather', '1.3.0')
    publish(repo)
    const newer = await h.marketplace.refresh(id)
    expect(newer.state.marketplaces[0]?.extensions[0]).toMatchObject({
      state: 'update',
      installedVersion: '1.2.0',
    })
  })

  it('offers a pre-release only to a user who opted in for that extension', async () => {
    const repo = marketplaceRepo()
    release(repo, 'extensions/weather', '1.1.0-rc.1')
    release(repo, 'versions/weather/1.0.0', '1.0.0')
    publish(repo, { history: ['versions/weather/1.0.0'] })
    const h = harness()
    const { id } = await offered(h, repo)
    expect(h.marketplace.state().marketplaces[0]?.extensions[0]?.version).toBe('1.0.0')
    const on = await h.marketplace.setPrerelease('weather', true)
    expect(on.state.prerelease).toEqual(['weather'])
    expect(on.state.marketplaces[0]?.extensions[0]?.version).toBe('1.1.0-rc.1')
    expect(h.reopen().state().prerelease).toEqual(['weather'])
    const off = await h.marketplace.setPrerelease('weather', false)
    expect(off.state.marketplaces[0]?.extensions[0]?.version).toBe('1.0.0')
    expect(await h.marketplace.install(id, 'weather')).toMatchObject({ ok: true })
  })

  it('never offers a revoked version and flags an installed one', async () => {
    const repo = marketplaceRepo()
    release(repo, 'extensions/weather', '1.2.0')
    release(repo, 'versions/weather/1.0.0', '1.0.0')
    publish(repo, { history: ['versions/weather/1.0.0'] })
    const h = harness()
    const { id } = await offered(h, repo)
    await h.marketplace.install(id, 'weather')
    publish(repo, {
      history: ['versions/weather/1.0.0'],
      revoked: [{ id: 'weather', version: '1.2.0' }],
    })
    const refreshed = await h.marketplace.refresh(id)
    expect(refreshed.state.marketplaces[0]?.extensions[0]).toMatchObject({
      version: '1.0.0',
      state: 'installed',
    })
    publish(repo, {
      history: ['versions/weather/1.0.0'],
      revoked: [
        { id: 'weather', version: '1.2.0' },
        { id: 'weather', version: '1.0.0' },
      ],
    })
    const none = await h.marketplace.refresh(id)
    expect(none.state.marketplaces[0]?.extensions).toEqual([])
    expect(none.state.marketplaces[0]?.problems).toEqual(['weather: every release was revoked'])
  })

  it('saves the revoked versions of the official marketplace only', async () => {
    const repo = marketplaceRepo()
    publish(repo, { revoked: [{ id: 'weather', version: '0.9.0' }] })
    const other = harness()
    await other.marketplace.add(repo)
    expect(other.revocations).toEqual([])
    const official = harness({ official: repo })
    await official.marketplace.refresh(official.marketplace.state().marketplaces[0]?.id)
    expect(official.revocations).toEqual([[{ id: 'weather', version: '0.9.0' }]])
    expect(official.rescans()).toBe(1)
  })
})

describe('Marketplace and a built-in', () => {
  function signedUpdate(version: string): string {
    const repo = marketplaceRepo()
    release(repo, 'extensions/weather', version)
    publish(repo)
    return repo
  }

  it('offers a newer official copy of a built-in only when its signature is accepted', async () => {
    const repo = signedUpdate('1.2.0')
    const signed = harness({
      official: repo,
      bundled: { weather: '1.0.0' },
      officialUpdate: () => null,
    })
    const { id, extension } = await offered(signed, repo)
    expect(extension).toMatchObject({ version: '1.2.0', state: 'available' })
    expect(await signed.marketplace.install(id, 'weather')).toMatchObject({ ok: true })
    expect(signed.marketplace.state().marketplaces[0]?.extensions[0]?.state).toBe('installed')
    expect(signed.forgotten).toEqual([])
    expect(await signed.marketplace.uninstall('weather')).toMatchObject({ ok: true })
    expect(signed.forgotten).toEqual([])
    expect(existsSync(join(signed.extensionsDir, 'weather'))).toBe(false)

    const unsigned = harness({ official: repo, bundled: { weather: '1.0.0' } })
    expect((await offered(unsigned, repo)).extension?.state).toBe('conflict')
  })

  it('never replaces a built-in from another marketplace or with a copy that is not newer', async () => {
    const repo = signedUpdate('1.2.0')
    const elsewhere = harness({ bundled: { weather: '1.0.0' }, officialUpdate: () => null })
    expect((await offered(elsewhere, repo)).extension?.state).toBe('conflict')
    const same = harness({
      official: repo,
      bundled: { weather: '1.2.0' },
      officialUpdate: () => null,
    })
    expect((await offered(same, repo)).extension?.state).toBe('conflict')
    const below = harness({
      official: repo,
      bundled: { weather: '1.3.0' },
      officialUpdate: () => null,
    })
    expect((await offered(below, repo)).extension?.state).toBe('conflict')
  })
})

describe('Marketplace development copies', () => {
  function folder(version: string, id = 'weather'): string {
    const dir = tmp()
    writeExtension(dir, '.', { ...weather(version), id })
    return dir
  }

  it('installs a folder, labels it dev and drops no earlier approval twice', async () => {
    const h = harness()
    const dir = folder('0.0.1')
    const res = await h.marketplace.installDev({ kind: 'folder', path: dir })
    expect(res.ok).toBe(true)
    expect(res.state.installed).toEqual(['weather'])
    expect(res.state.dev).toEqual({ weather: `folder ${dir}` })
    expect(h.forgotten).toEqual(['weather'])
    await h.marketplace.installDev({ kind: 'folder', path: dir })
    expect(h.forgotten).toEqual(['weather'])
    await h.marketplace.installDev({ kind: 'folder', path: folder('0.0.2') })
    expect(h.forgotten).toEqual(['weather', 'weather'])
    expect(h.reopen().state().dev.weather).toContain('folder ')
    const gone = await h.marketplace.uninstall('weather')
    expect(gone.state.dev).toEqual({})
  })

  it('installs a git branch, from a subfolder when one is named', async () => {
    const repo = tmp()
    git(repo, 'init', '-b', 'main')
    writeExtension(repo, 'tools/weather', weather('0.0.3'))
    commit(repo)
    git(repo, 'branch', 'try')
    const h = harness()
    const res = await h.marketplace.installDev({
      kind: 'git',
      url: repo,
      branch: 'try',
      path: 'tools/weather',
    })
    expect(res.ok).toBe(true)
    expect(res.state.dev.weather).toContain('try tools/weather')
    expect(
      await h.marketplace.installDev({ kind: 'git', url: repo, branch: 'nope' }),
    ).toMatchObject({
      ok: false,
      error: 'clone-failed',
    })
  })

  it('refuses a built-in id, an extension from a marketplace and a source that is not one', async () => {
    const h = harness({ bundled: { weather: '1.0.0' } })
    expect(await h.marketplace.installDev({ kind: 'folder', path: folder('0.0.1') })).toMatchObject(
      { ok: false, error: 'conflict' },
    )
    const other = harness()
    mkdirSync(join(other.extensionsDir, 'weather'))
    expect(
      await other.marketplace.installDev({ kind: 'folder', path: folder('0.0.1') }),
    ).toMatchObject({ ok: false, error: 'conflict' })
    for (const bad of [
      { kind: 'folder', path: 'relative' },
      { kind: 'folder', path: '/nonexistent/folder' },
      { kind: 'git', url: '--upload-pack=x', branch: 'main' },
      { kind: 'git', url: 'acme/ext', branch: '--force' },
      { kind: 'git', url: 'acme/ext', branch: 'main', path: '../x' },
      { kind: 'other' },
      null,
    ]) {
      expect(await other.marketplace.installDev(bad)).toMatchObject({
        ok: false,
        error: 'invalid-source',
      })
    }
  })
})

describe('Marketplace revocation and pre-release stickiness', () => {
  it('stops an installed version the marketplace revokes, never a built-in', async () => {
    const repo = marketplaceRepo()
    const h = harness()
    const { id } = await offered(h, repo)
    await h.marketplace.install(id, 'weather')
    publish(repo, { revoked: [{ id: 'weather', version: '1.0.0' }] })
    await h.marketplace.refresh(id)
    expect(h.disabled).toEqual(['weather'])
    await h.marketplace.refresh(id)
    expect(h.disabled).toEqual(['weather'])
    expect(h.reopen().state().marketplaces).toHaveLength(1)
    await h.reopen().refresh(id)
    expect(h.disabled).toEqual(['weather'])

    const builtin = harness({ bundled: { weather: '0.9.0' } })
    const again = await offered(builtin, repo)
    await builtin.marketplace.refresh(again.id)
    expect(builtin.disabled).toEqual([])
  })

  it('offers the newest stable to a human who left pre-releases, and asks before going lower', async () => {
    const repo = marketplaceRepo()
    release(repo, 'extensions/weather', '1.1.0-rc.1')
    release(repo, 'versions/weather/1.0.0', '1.0.0')
    publish(repo, { history: ['versions/weather/1.0.0'] })
    const h = harness()
    const { id } = await offered(h, repo)
    await h.marketplace.setPrerelease('weather', true)
    await h.marketplace.install(id, 'weather')
    expect(h.marketplace.state().marketplaces[0]?.extensions[0]).toMatchObject({
      state: 'installed',
    })

    const off = await h.marketplace.setPrerelease('weather', false)
    expect(off.state.marketplaces[0]?.extensions[0]).toMatchObject({
      version: '1.0.0',
      state: 'update',
      installedVersion: '1.1.0-rc.1',
      downgrade: true,
    })
    expect(await h.marketplace.install(id, 'weather')).toMatchObject({
      ok: false,
      error: 'downgrade-unconfirmed',
    })
    expect(
      JSON.parse(readFileSync(join(h.extensionsDir, 'weather', 'ostia.json'), 'utf8')).version,
    ).toBe('1.1.0-rc.1')
    expect(await h.marketplace.install(id, 'weather', true)).toMatchObject({ ok: true })
    expect(
      JSON.parse(readFileSync(join(h.extensionsDir, 'weather', 'ostia.json'), 'utf8')).version,
    ).toBe('1.0.0')
  })

  it('does not call a higher stable release a downgrade', async () => {
    const repo = marketplaceRepo()
    release(repo, 'extensions/weather', '1.1.0-rc.1')
    publish(repo)
    const h = harness()
    const { id } = await offered(h, repo)
    await h.marketplace.setPrerelease('weather', true)
    await h.marketplace.install(id, 'weather')
    release(repo, 'extensions/weather', '1.1.0')
    publish(repo)
    await h.marketplace.setPrerelease('weather', false)
    const refreshed = await h.marketplace.refresh(id)
    const entry = refreshed.state.marketplaces[0]?.extensions[0]
    expect(entry).toMatchObject({ version: '1.1.0', state: 'update' })
    expect(entry?.downgrade).toBeUndefined()
    expect(await h.marketplace.install(id, 'weather')).toMatchObject({ ok: true })
  })
})

describe('Marketplace and a built-in that is being verified', () => {
  function repoWith(version: string): string {
    const repo = marketplaceRepo()
    release(repo, 'extensions/weather', version)
    publish(repo)
    return repo
  }

  it('shows the update as available, not as a problem, until the verdict says otherwise', async () => {
    const repo = repoWith('1.2.0')
    const h = harness({
      official: repo,
      bundled: { weather: '1.0.0' },
      officialUpdate: () => OFFICIAL_UPDATE_PENDING,
    })
    expect((await offered(h, repo)).extension?.state).toBe('available')
  })

  it('waits for the verification before it installs, and refuses what fails it', async () => {
    const repo = repoWith('1.2.0')
    let verdict: string | null = OFFICIAL_UPDATE_PENDING
    let waited = false
    const make = (final: string | null) => {
      verdict = OFFICIAL_UPDATE_PENDING
      return harness({
        official: repo,
        bundled: { weather: '1.0.0' },
        officialUpdate: () => verdict,
        verified: async () => {
          waited = true
          verdict = final
        },
      })
    }
    const good = make(null)
    const { id } = await offered(good, repo)
    expect(await good.marketplace.install(id, 'weather')).toMatchObject({ ok: true })
    expect(waited).toBe(true)

    const bad = make('the signature does not match')
    const again = await offered(bad, repo)
    expect(await bad.marketplace.install(again.id, 'weather')).toMatchObject({
      ok: false,
      error: 'conflict',
    })
    expect(existsSync(join(bad.extensionsDir, 'weather'))).toBe(false)
  })

  it('does not offer a built-in a way back from a pre-release it never asked for', async () => {
    const repo = marketplaceRepo()
    release(repo, 'extensions/weather', '1.3.0-rc.1')
    release(repo, 'versions/weather/1.2.0', '1.2.0')
    publish(repo, { history: ['versions/weather/1.2.0'] })
    const h = harness({
      official: repo,
      bundled: { weather: '1.0.0' },
      officialUpdate: () => null,
    })
    const { id } = await offered(h, repo)
    await h.marketplace.setPrerelease('weather', true)
    await h.marketplace.install(id, 'weather')
    const off = await h.marketplace.setPrerelease('weather', false)
    const entry = off.state.marketplaces[0]?.extensions[0]
    expect(entry).toMatchObject({ version: '1.2.0' })
    expect(entry?.downgrade).toBeUndefined()
  })
})
