import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FAKE } from '../../test/fixtures/secrets/samples'
import { envName } from '../shared/appEnv'
import {
  TELEMETRY_QUEUE_MAX,
  TELEMETRY_SEND_ATTEMPTS,
  TELEMETRY_URL_ENV,
  type TelemetryContexts,
  type TelemetrySettings,
} from '../shared/telemetry'

const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler),
    on: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler),
  },
}))

const { createTelemetry, readTelemetrySettings, registerTelemetry, telemetryEndpoint } =
  await import('./telemetry')

const contexts: TelemetryContexts = {
  app: { app_version: '1.0.0' },
  os: { name: 'linux', version: '6' },
  device: { arch: 'x64' },
  runtime: { name: 'electron', version: '33' },
}

const endpoint = { url: 'https://glitchtip.example/api/1/envelope/', publicKey: 'k' }

interface Harness {
  file: string
  settings: TelemetrySettings
  sent: Array<{ url: string; headers: Record<string, string>; body: string }>
  respond: () => Response
  fetchFn: typeof fetch
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ostia-telemetry-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.useRealTimers()
})

function harness(settings: Partial<TelemetrySettings> = {}): Harness {
  const h: Harness = {
    file: join(dir, 'telemetry.json'),
    settings: { errors: false, usage: false, ...settings },
    sent: [],
    respond: () => new Response(null, { status: 200 }),
    fetchFn: async (input, init) => {
      h.sent.push({
        url: String(input),
        headers: init?.headers as Record<string, string>,
        body: String(init?.body),
      })
      return h.respond()
    },
  }
  return h
}

function create(h: Harness, extra: Partial<Parameters<typeof createTelemetry>[0]> = {}) {
  return createTelemetry({
    file: h.file,
    version: '1.0.0',
    endpoint,
    contexts,
    settings: () => h.settings,
    marketplaceExtensions: () => ['trellis'],
    fetchFn: h.fetchFn,
    flushDelayMs: 0,
    retryDelayMs: 0,
    ...extra,
  })
}

const boom = () => ({ source: 'main-exception' as const, name: 'Error', message: 'boom' })

const envelopeEvents = (body: string) =>
  body
    .split('\n')
    .filter((line, i) => i > 0 && i % 2 === 0 && line)
    .map((line) => JSON.parse(line))

describe('telemetryEndpoint', () => {
  it('honours the url override only when unpackaged, else the built-in DSN', () => {
    const env = { [envName(TELEMETRY_URL_ENV)]: 'http://k@127.0.0.1:1/7' }
    expect(telemetryEndpoint(false, env)).toEqual({
      url: 'http://127.0.0.1:1/api/7/envelope/',
      publicKey: 'k',
    })
    const shipped = { url: 'https://telemetry.apogex.dev/api/1/envelope/', publicKey: 'k' }
    expect(telemetryEndpoint(true, env)?.url).toBe(shipped.url)
    expect(telemetryEndpoint(false, {})?.url).toBe(shipped.url)
    expect(telemetryEndpoint(true, env)?.publicKey).toMatch(/^[0-9a-f]{32}$/)
  })
})

describe('readTelemetrySettings', () => {
  it('reads privacy.telemetry from the settings file and is off for anything else', () => {
    expect(readTelemetrySettings({ privacy: { telemetry: { errors: true } } })).toEqual({
      errors: true,
      usage: false,
    })
    expect(readTelemetrySettings(null)).toEqual({ errors: false, usage: false })
    expect(readTelemetrySettings({ privacy: 'x' })).toEqual({ errors: false, usage: false })
  })
})

describe('createTelemetry', () => {
  it('sends nothing while both switches are off', async () => {
    const h = harness()
    const t = create(h)
    t.error(boom())
    t.count('command', 'pane.split')
    await t.flush()
    await t.shutdown()
    expect(h.sent).toEqual([])
    expect(t.reports()).toEqual({ queued: [], sent: [] })
  })

  it('queues an error report and sends it as one Sentry envelope with the auth header', async () => {
    const h = harness({ errors: true })
    const t = create(h)
    t.error({
      ...boom(),
      message: `token ${FAKE.githubClassic} in /home/ann/x`,
      stack: 'Error: boom\n    at f (/home/ann/x.js:1:2)',
    })
    expect(t.reports().queued).toHaveLength(1)
    await t.flush()
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].url).toBe(endpoint.url)
    expect(h.sent[0].headers['X-Sentry-Auth']).toBe(
      'Sentry sentry_version=7, sentry_key=k, sentry_client=ostia/1.0.0',
    )
    expect(h.sent[0].headers['Content-Type']).toBe('application/x-sentry-envelope')
    expect(h.sent[0].body).not.toContain('ghp_')
    expect(h.sent[0].body).not.toContain('/home/ann')
    const [event] = envelopeEvents(h.sent[0].body)
    expect(event.user).toEqual({ id: t.state().installId })
    expect(event.user.ip_address).toBeUndefined()
    expect(event.breadcrumbs).toBeUndefined()
    expect(event.request).toBeUndefined()
    expect(event.environment).toBeUndefined()
    expect(event.contexts).toEqual(contexts)
    expect(t.reports().queued).toEqual([])
    expect(t.reports().sent).toEqual([event])
  })

  it('persists the queue and the install id in a 0600 file and reloads them', async () => {
    const h = harness({ errors: true })
    const t = create(h, { endpoint: null })
    t.error(boom())
    const id = t.state().installId
    expect(statSync(h.file).mode & 0o777).toBe(0o600)
    const again = create(h)
    expect(again.state().installId).toBe(id)
    expect(again.reports().queued).toHaveLength(1)
    await again.flush()
    expect(h.sent).toHaveLength(1)
  })

  it('caps the queue and drops a report after the retry cap', async () => {
    const h = harness({ errors: true })
    h.respond = () => new Response(null, { status: 500 })
    const t = create(h, { endpoint: null })
    for (let i = 0; i < TELEMETRY_QUEUE_MAX + 5; i++) t.error(boom())
    expect(t.reports().queued).toHaveLength(TELEMETRY_QUEUE_MAX)
    const failing = create(h)
    for (let i = 0; i < TELEMETRY_SEND_ATTEMPTS; i++) await failing.flush()
    expect(h.sent).toHaveLength(TELEMETRY_SEND_ATTEMPTS)
    expect(failing.reports().queued).toHaveLength(TELEMETRY_QUEUE_MAX - 20)
    expect(JSON.parse(readFileSync(h.file, 'utf8')).queue).toHaveLength(TELEMETRY_QUEUE_MAX - 20)
  })

  it('drops queued reports of a kind whose switch turned off', async () => {
    const h = harness({ errors: true, usage: true })
    const t = create(h, { endpoint: null, usageIntervalMs: 60_000 })
    t.error(boom())
    t.count('command', 'pane.split')
    vi.useFakeTimers()
    const live = create(h, { endpoint: null, usageIntervalMs: 60_000 })
    live.count('surface', 'terminal')
    vi.advanceTimersByTime(60_000)
    expect(live.reports().queued.map((r) => r.level)).toEqual(['error', 'info'])
    h.settings = { errors: false, usage: true }
    live.settingsChanged()
    expect(live.reports().queued.map((r) => r.level)).toEqual(['info'])
    h.settings = { errors: false, usage: false }
    live.settingsChanged()
    expect(live.reports().queued).toEqual([])
  })

  it('sends one usage event at shutdown with the counts, session length and marketplace ids', async () => {
    const h = harness({ usage: true })
    let now = 1_000_000
    const t = create(h, { now: () => now })
    t.count('command', 'pane.split')
    t.count('command', 'pane.split')
    t.count('surface', 'browser')
    t.count('settings', 'privacy')
    t.count('command', 'bad id with spaces')
    t.count('nope' as never, 'x')
    now += 31 * 60_000
    await t.shutdown()
    expect(h.sent).toHaveLength(1)
    const [event] = envelopeEvents(h.sent[0].body)
    expect(event.level).toBe('info')
    expect(event.message).toBe('usage')
    expect(event.tags).toEqual({ app_starts: '1', session_minutes: '31' })
    expect(event.extra).toEqual({
      commands: { 'pane.split': 2 },
      surfaces: { browser: 1 },
      settings: { privacy: 1 },
      marketplace_extensions: ['trellis'],
    })
    expect(event.exception).toBeUndefined()
  })

  it('reset gives a new install id and forgets every report', async () => {
    const h = harness({ errors: true })
    const t = create(h)
    t.error(boom())
    await t.flush()
    const before = t.state().installId
    const after = t.resetInstallId()
    expect(after).not.toBe(before)
    expect(t.state().installId).toBe(after)
    expect(t.reports()).toEqual({ queued: [], sent: [] })
  })

  it('drops a corrupt queue entry instead of failing every flush', async () => {
    const h = harness({ errors: true })
    const t = create(h)
    t.error(boom())
    const file = JSON.parse(readFileSync(h.file, 'utf8'))
    file.queue.push({ report: null, attempts: 0 }, { report: { level: 'error' }, attempts: 0 })
    file.sent = [null]
    writeFileSync(h.file, JSON.stringify(file))
    const again = create(h)
    expect(again.reports()).toEqual({ queued: t.reports().queued, sent: [] })
    await again.flush()
    await again.shutdown()
    expect(h.sent).toHaveLength(1)
    expect(again.reports().queued).toEqual([])
  })

  it('reports whether a build has an endpoint', () => {
    const h = harness()
    expect(create(h).state().available).toBe(true)
    expect(create(h, { endpoint: null }).state().available).toBe(false)
  })

  it('remembers that the consent dialog was answered', () => {
    const h = harness()
    const t = create(h)
    expect(t.state().asked).toBe(false)
    t.consented()
    expect(create(h).state().asked).toBe(true)
  })

  it('never contacts the network without an endpoint', async () => {
    const h = harness({ errors: true })
    const t = create(h, { endpoint: null })
    t.error(boom())
    await t.flush()
    await t.shutdown()
    expect(h.sent).toEqual([])
    expect(t.reports().queued).toHaveLength(1)
  })
})

describe('sendEnvelope over http', () => {
  let server: Server
  let url: string
  const received: Array<{ auth: string | undefined; body: string }> = []

  beforeEach(async () => {
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        received.push({ auth: req.headers['x-sentry-auth'] as string | undefined, body })
        res.writeHead(200).end('{}')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    url = `http://k@127.0.0.1:${(server.address() as AddressInfo).port}/3`
  })

  afterEach(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('posts the envelope to the DSN project endpoint', async () => {
    const h = harness({ errors: true })
    const t = create(h, {
      endpoint: telemetryEndpoint(false, { [envName(TELEMETRY_URL_ENV)]: url }),
      fetchFn: undefined,
    })
    t.error(boom())
    await t.flush()
    expect(received).toHaveLength(1)
    expect(received[0].auth).toContain('sentry_key=k')
    expect(envelopeEvents(received[0].body)[0].exception.values[0].value).toBe('boom')
  })
})

describe('registerTelemetry', () => {
  it('answers state, consent, reset and reports over IPC and validates counts', async () => {
    const t = registerTelemetry({
      file: join(dir, 'telemetry.json'),
      version: '1.0.0',
      readSettings: () => ({ privacy: { telemetry: { usage: true } } }),
      marketplaceExtensions: () => [],
    })
    const state = (await handlers.get('telemetry:state')?.()) as { installId: string }
    expect(state.installId).toBe(t.state().installId)
    handlers.get('telemetry:count')?.({}, 'command', 'pane.split')
    handlers.get('telemetry:count')?.({}, 42, 'pane.split')
    await handlers.get('telemetry:consented')?.()
    expect(t.state().asked).toBe(true)
    const next = (await handlers.get('telemetry:reset-id')?.()) as string
    expect(next).not.toBe(state.installId)
    expect(await handlers.get('telemetry:reports')?.()).toEqual({ queued: [], sent: [] })
    await t.shutdown()
  })
})
