import { mkdtempSync, rmSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReleaseInfo } from '../shared/releases'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
const sent: Array<[string, unknown]> = []

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: { send: (channel: string, payload: unknown) => sent.push([channel, payload]) },
      },
    ],
  },
  app: { isPackaged: false, getVersion: () => '0.2.0' },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler),
  },
}))

const {
  RELEASE_API_URL_ENV,
  RELEASE_CHECK_INTERVAL_MS,
  RELEASE_CHECK_RETRY_MS,
  createReleaseChecker,
  fetchLatestRelease,
  readCheckForUpdates,
  registerReleaseCheck,
  releaseEndpoint,
} = await import('./releaseCheck')
type LatestRelease = import('./releaseCheck').LatestRelease

const release = (version: string): ReleaseInfo => ({
  version,
  url: `https://github.com/aurigax-ai/ostia/releases/tag/v${version}`,
})

const found = (version: string): LatestRelease => ({ kind: 'release', release: release(version) })

const body = (version: string, extra: object = {}): string =>
  JSON.stringify({
    tag_name: `v${version}`,
    html_url: release(version).url,
    draft: false,
    prerelease: false,
    ...extra,
  })

interface FakeGitHub {
  url: string
  requests: Array<{ url: string | undefined; headers: Record<string, unknown> }>
  reply: { status: number; body: string; location?: string } | 'hang'
  close: () => Promise<void>
}

async function startFakeGitHub(): Promise<FakeGitHub> {
  const fake: FakeGitHub = {
    url: '',
    requests: [],
    reply: { status: 404, body: '{"message":"Not Found"}' },
    close: async () => {},
  }
  const server: Server = createServer((req, res) => {
    fake.requests.push({ url: req.url, headers: { ...req.headers } })
    if (fake.reply === 'hang') return
    res.writeHead(fake.reply.status, {
      'content-type': 'application/json',
      ...(fake.reply.location ? { location: fake.reply.location } : {}),
    })
    res.end(fake.reply.body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  fake.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  return fake
}

function harness(opts: { current?: string; dismissed?: string | null; enabled?: boolean } = {}) {
  const state = {
    now: 1_000_000,
    enabled: opts.enabled ?? true,
    latest: { kind: 'none' } as LatestRelease,
    saved: [] as string[],
    changes: [] as Array<ReleaseInfo | null>,
    logs: [] as Array<[string, string, string | undefined]>,
  }
  const fetchLatest = vi.fn(async () => state.latest)
  const checker = createReleaseChecker({
    currentVersion: opts.current ?? '0.2.0',
    fetchLatest,
    now: () => state.now,
    enabled: () => state.enabled,
    loadDismissed: () => opts.dismissed ?? null,
    saveDismissed: (version) => state.saved.push(version),
    onChange: (pending) => state.changes.push(pending),
    log: (trigger, outcome, latest) => state.logs.push([trigger, outcome, latest]),
  })
  return { state, fetchLatest, checker }
}

describe('releaseEndpoint', () => {
  it('ignores the override in a packaged build and checks automatically', () => {
    expect(releaseEndpoint(true, { [RELEASE_API_URL_ENV]: 'http://127.0.0.1:9' })).toEqual({
      baseUrl: 'https://api.github.com',
      automatic: true,
    })
    expect(
      releaseEndpoint(true, { [RELEASE_API_URL_ENV]: 'http://127.0.0.1:9', NODE_ENV: 'test' }),
    ).toEqual({ baseUrl: 'https://api.github.com', automatic: true })
  })

  it('checks automatically in an unpackaged run only when a test names the server', () => {
    expect(releaseEndpoint(false, {})).toEqual({
      baseUrl: 'https://api.github.com',
      automatic: false,
    })
    expect(releaseEndpoint(false, { [RELEASE_API_URL_ENV]: 'http://127.0.0.1:9' })).toEqual({
      baseUrl: 'http://127.0.0.1:9',
      automatic: true,
    })
  })
})

describe('readCheckForUpdates', () => {
  it('is on unless the human turned it off', () => {
    expect(readCheckForUpdates({})).toBe(true)
    expect(readCheckForUpdates(null)).toBe(true)
    expect(readCheckForUpdates({ behavior: { checkForUpdates: 'no' } })).toBe(true)
    expect(readCheckForUpdates({ behavior: { checkForUpdates: false } })).toBe(false)
  })
})

describe('createReleaseChecker', () => {
  it('announces a strictly newer release once and reports it as available', async () => {
    const { state, checker } = harness()
    state.latest = found('0.3.0')

    expect(await checker.check('manual')).toEqual({
      status: 'available',
      release: release('0.3.0'),
    })
    await checker.check('manual')

    expect(state.changes).toEqual([release('0.3.0')])
    expect(checker.pending()).toEqual(release('0.3.0'))
    expect(state.logs[0]).toEqual(['manual', 'available', '0.3.0'])
  })

  it('reports the running version as latest for the same, an older or no release', async () => {
    const { state, checker } = harness()
    for (const latest of [found('0.2.0'), found('0.1.9'), { kind: 'none' } as const]) {
      state.latest = latest
      expect(await checker.check('manual')).toEqual({ status: 'latest', version: '0.2.0' })
    }
    expect(state.changes).toEqual([])
    expect(checker.pending()).toBeNull()
  })

  it('checks on the first tick, then not again until 24 hours have passed', async () => {
    const { state, fetchLatest, checker } = harness()

    await checker.tick()
    expect(fetchLatest).toHaveBeenCalledTimes(1)

    state.now += RELEASE_CHECK_INTERVAL_MS - 1
    await checker.tick()
    expect(fetchLatest).toHaveBeenCalledTimes(1)

    state.now += 1
    await checker.tick()
    expect(fetchLatest).toHaveBeenCalledTimes(2)
    expect(state.logs.map(([trigger]) => trigger)).toEqual(['auto', 'auto'])
  })

  it('retries a failed check after an hour instead of a day', async () => {
    const { state, fetchLatest, checker } = harness()
    state.latest = { kind: 'error', error: 'offline' }

    await checker.tick()
    state.now += RELEASE_CHECK_RETRY_MS - 1
    await checker.tick()
    expect(fetchLatest).toHaveBeenCalledTimes(1)

    state.now += 1
    await checker.tick()
    expect(fetchLatest).toHaveBeenCalledTimes(2)
  })

  it('never checks on a tick while the setting is off, and resumes when it is turned on', async () => {
    const { state, fetchLatest, checker } = harness({ enabled: false })

    await checker.tick()
    expect(fetchLatest).not.toHaveBeenCalled()

    state.enabled = true
    await checker.tick()
    expect(fetchLatest).toHaveBeenCalledTimes(1)
  })

  it('counts a manual check toward the daily schedule, even with the setting off', async () => {
    const { state, fetchLatest, checker } = harness({ enabled: false })

    await checker.check('manual')
    state.enabled = true
    await checker.tick()

    expect(fetchLatest).toHaveBeenCalledTimes(1)
  })

  it('shares one request between checks that overlap', async () => {
    const { fetchLatest, checker } = harness()
    await Promise.all([checker.check('auto'), checker.check('manual')])
    expect(fetchLatest).toHaveBeenCalledTimes(1)
  })

  it('remembers a dismissed version and stays quiet until a newer one appears', async () => {
    const { state, checker } = harness()
    state.latest = found('0.3.0')
    await checker.check('auto')

    checker.dismiss()
    expect(state.saved).toEqual(['0.3.0'])
    expect(checker.pending()).toBeNull()
    expect(state.changes).toEqual([release('0.3.0'), null])

    expect(await checker.check('manual')).toEqual({
      status: 'available',
      release: release('0.3.0'),
    })
    expect(state.changes).toHaveLength(2)

    state.latest = found('0.4.0')
    await checker.check('auto')
    expect(checker.pending()).toEqual(release('0.4.0'))
    expect(state.changes).toEqual([release('0.3.0'), null, release('0.4.0')])
  })

  it('stays quiet about a version dismissed in an earlier run', async () => {
    const { state, checker } = harness({ dismissed: '0.3.0' })
    state.latest = found('0.3.0')

    await checker.check('auto')

    expect(state.changes).toEqual([])
    expect(checker.available()).toEqual(release('0.3.0'))
    expect(checker.pending()).toBeNull()
  })

  it('keeps the known release when a later check fails', async () => {
    const { state, checker } = harness()
    state.latest = found('0.3.0')
    await checker.check('auto')

    state.latest = { kind: 'error', error: 'rate-limited' }
    expect(await checker.check('manual')).toEqual({ status: 'error', error: 'rate-limited' })

    expect(checker.pending()).toEqual(release('0.3.0'))
    expect(state.changes).toEqual([release('0.3.0')])
  })

  it('does nothing on dismiss when no release is known', () => {
    const { state, checker } = harness()
    checker.dismiss()
    expect(state.saved).toEqual([])
    expect(state.changes).toEqual([])
  })
})

describe('fetchLatestRelease', () => {
  let github: FakeGitHub

  beforeEach(async () => {
    github = await startFakeGitHub()
  })

  afterEach(() => github.close())

  const fetchFrom = (timeoutMs?: number): Promise<LatestRelease> =>
    fetchLatestRelease({ baseUrl: github.url, userAgent: 'pine/0.2.0', timeoutMs })

  it('asks for the latest release of the repository and sends only a product user agent', async () => {
    github.reply = { status: 200, body: body('0.3.0') }

    expect(await fetchFrom()).toEqual(found('0.3.0'))

    expect(github.requests).toHaveLength(1)
    const { url, headers } = github.requests[0]
    expect(url).toBe('/repos/aurigax-ai/ostia/releases/latest')
    expect(headers['user-agent']).toBe('pine/0.2.0')
    expect(headers.authorization).toBeUndefined()
    expect(headers.cookie).toBeUndefined()
  })

  it('reports no release for 404, a draft or a prerelease', async () => {
    expect(await fetchFrom()).toEqual({ kind: 'none' })
    github.reply = { status: 200, body: body('0.3.0', { draft: true }) }
    expect(await fetchFrom()).toEqual({ kind: 'none' })
    github.reply = { status: 200, body: body('0.3.0', { prerelease: true }) }
    expect(await fetchFrom()).toEqual({ kind: 'none' })
  })

  it('reports a rate limit for 403 and 429', async () => {
    github.reply = { status: 403, body: '{"message":"API rate limit exceeded"}' }
    expect(await fetchFrom()).toEqual({ kind: 'error', error: 'rate-limited' })
    github.reply = { status: 429, body: '{}' }
    expect(await fetchFrom()).toEqual({ kind: 'error', error: 'rate-limited' })
  })

  it('reports unavailable for a server error, malformed JSON or an untrusted release page', async () => {
    const unavailable = { kind: 'error', error: 'unavailable' }
    github.reply = { status: 500, body: '{}' }
    expect(await fetchFrom()).toEqual(unavailable)
    github.reply = { status: 200, body: '<html>captive portal</html>' }
    expect(await fetchFrom()).toEqual(unavailable)
    github.reply = {
      status: 200,
      body: body('0.3.0', {
        html_url: 'https://evil.example/aurigax-ai/ostia/releases/tag/v0.3.0',
      }),
    }
    expect(await fetchFrom()).toEqual(unavailable)
    github.reply = { status: 200, body: body('0.3.0', { body: 'x'.repeat(1024 * 1024) }) }
    expect(await fetchFrom()).toEqual(unavailable)
  })

  it('refuses to follow a redirect', async () => {
    github.reply = { status: 302, body: '', location: `${github.url}/elsewhere` }
    expect(await fetchFrom()).toEqual({ kind: 'error', error: 'unavailable' })
    expect(github.requests).toHaveLength(1)
  })

  it('reports offline when the server never answers or cannot be reached', async () => {
    github.reply = 'hang'
    expect(await fetchFrom(50)).toEqual({ kind: 'error', error: 'offline' })

    await github.close()
    expect(await fetchFrom()).toEqual({ kind: 'error', error: 'offline' })
  })
})

describe('registerReleaseCheck', () => {
  let github: FakeGitHub
  let dataHome: string
  const openExternal = vi.fn(() => true)
  const info = vi.fn()

  beforeEach(async () => {
    github = await startFakeGitHub()
    handlers.clear()
    sent.length = 0
    openExternal.mockClear()
    info.mockClear()
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] })
    vi.stubEnv(RELEASE_API_URL_ENV, github.url)
    dataHome = mkdtempSync(join(tmpdir(), 'pine-release-check-'))
    vi.stubEnv('XDG_DATA_HOME', dataHome)
  })

  afterEach(async () => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    rmSync(dataHome, { recursive: true, force: true })
    await github.close()
  })

  const register = (settings: unknown = {}): void =>
    registerReleaseCheck({
      openExternal,
      readSettings: () => settings,
      log: { file: '', info, warn: vi.fn(), error: vi.fn() },
    })

  const invoke = (channel: string): unknown => handlers.get(channel)?.()

  it('answers a manual check with the newer release and opens only its validated page', async () => {
    github.reply = { status: 200, body: body('0.3.0') }
    register()

    expect(await invoke('app:release-open')).toBe(false)
    expect(await invoke('app:release-check')).toEqual({
      status: 'available',
      release: release('0.3.0'),
    })
    expect(sent).toEqual([['app:release-available', release('0.3.0')]])
    expect(await invoke('app:release-state')).toEqual(release('0.3.0'))

    expect(await invoke('app:release-open')).toBe(true)
    expect(openExternal).toHaveBeenCalledWith(release('0.3.0').url)
    expect(github.requests[0].headers['user-agent']).toBe('pine/0.2.0')
    expect(info).toHaveBeenCalledWith('release-check', {
      trigger: 'manual',
      outcome: 'available',
      latest: '0.3.0',
    })
  })

  it('answers latest for the same, an older or no release, and an error for a rate limit', async () => {
    register()
    github.reply = { status: 200, body: body('0.2.0') }
    expect(await invoke('app:release-check')).toEqual({ status: 'latest', version: '0.2.0' })
    github.reply = { status: 200, body: body('0.1.0') }
    expect(await invoke('app:release-check')).toEqual({ status: 'latest', version: '0.2.0' })
    github.reply = { status: 404, body: '{}' }
    expect(await invoke('app:release-check')).toEqual({ status: 'latest', version: '0.2.0' })
    github.reply = { status: 403, body: '{}' }
    expect(await invoke('app:release-check')).toEqual({ status: 'error', error: 'rate-limited' })
    expect(sent).toEqual([])
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('checks by itself shortly after startup, and not at all while the setting is off', async () => {
    github.reply = { status: 200, body: body('0.3.0') }
    register({ behavior: { checkForUpdates: false } })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(github.requests).toHaveLength(0)

    handlers.clear()
    register()
    await vi.advanceTimersByTimeAsync(10_000)
    await vi.waitFor(() => expect(sent).toEqual([['app:release-available', release('0.3.0')]]))
    expect(github.requests).toHaveLength(1)
  })

  it('saves a dismissal so the next run stays quiet about that version', async () => {
    github.reply = { status: 200, body: body('0.3.0') }
    register()
    await invoke('app:release-check')
    await invoke('app:release-dismiss')
    expect(sent.at(-1)).toEqual(['app:release-available', null])

    handlers.clear()
    sent.length = 0
    register()
    expect(await invoke('app:release-check')).toEqual({
      status: 'available',
      release: release('0.3.0'),
    })
    expect(await invoke('app:release-state')).toBeNull()
    expect(sent).toEqual([])
  })
})
