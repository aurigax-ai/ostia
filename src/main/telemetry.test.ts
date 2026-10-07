import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FAKE } from '../../test/fixtures/secrets/samples'
import { envName } from '../shared/appEnv'
import {
  DEFAULT_TELEMETRY_SETTINGS,
  type InstallContext,
  TELEMETRY_CATEGORIES,
  TELEMETRY_QUEUE_MAX,
  TELEMETRY_SEND_ATTEMPTS,
  TELEMETRY_URL_ENV,
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
type SessionFacts = import('./telemetry').SessionFacts

const context: InstallContext = {
  app_version: '1.0.0',
  electron_version: '33',
  os_name: 'linux',
  os_version: '6',
  arch: 'x64',
  locale: 'en',
  channel: 'source',
}

const endpoint = { url: 'https://us.i.posthog.com/batch/', apiKey: 'phc_test' }

const facts: SessionFacts = {
  windows: '1',
  workspaces: '2-3',
  restore: 'ok',
  inEffect: {
    features: { input_mode: 'terminal', prompt_style: 'shell' },
    terminal: { engine: 'xterm', gpu: 'on' },
  },
  installedExtensions: ['trellis'],
  enabledExtensions: ['trellis'],
}

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

const only = (...on: Array<keyof TelemetrySettings>): TelemetrySettings =>
  Object.fromEntries(TELEMETRY_CATEGORIES.map((k) => [k, on.includes(k)])) as TelemetrySettings

function harness(settings: TelemetrySettings = DEFAULT_TELEMETRY_SETTINGS): Harness {
  const h: Harness = {
    file: join(dir, 'telemetry.json'),
    settings,
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
    endpoint,
    context: () => context,
    settings: () => h.settings,
    session: () => facts,
    fetchFn: h.fetchFn,
    flushDelayMs: 0,
    retryDelayMs: 0,
    ...extra,
  })
}

const boom = () => ({ source: 'main-exception' as const, name: 'Error', message: 'boom' })

interface SentEvent {
  event: string
  distinct_id: string
  properties: Record<string, unknown> & { $exception_list?: Array<{ value: string }> }
}

const batchEvents = (body: string): SentEvent[] => JSON.parse(body).batch

describe('telemetryEndpoint', () => {
  const stamp = { key: 'phc_release', host: 'https://us.i.posthog.com' }

  it('uses the build stamp from release.yml, and nothing without one', () => {
    expect(telemetryEndpoint(true, {}, stamp)).toEqual({
      url: 'https://us.i.posthog.com/batch/',
      apiKey: 'phc_release',
    })
    expect(telemetryEndpoint(true, {}, undefined)).toBeNull()
    expect(telemetryEndpoint(false, {}, undefined)).toBeNull()
  })

  it('honours the url override only when unpackaged', () => {
    const env = { [envName(TELEMETRY_URL_ENV)]: 'http://phc_e2e@127.0.0.1:1' }
    expect(telemetryEndpoint(false, env, stamp)).toEqual({
      url: 'http://127.0.0.1:1/batch/',
      apiKey: 'phc_e2e',
    })
    expect(telemetryEndpoint(true, env, stamp)?.apiKey).toBe('phc_release')
    expect(telemetryEndpoint(true, env, undefined)).toBeNull()
  })
})

describe('readTelemetrySettings', () => {
  it('reads privacy.telemetry from the settings file and is off for anything else', () => {
    expect(readTelemetrySettings({ privacy: { telemetry: { errors: true } } })).toEqual(
      only('errors'),
    )
    expect(readTelemetrySettings(null)).toEqual(DEFAULT_TELEMETRY_SETTINGS)
    expect(readTelemetrySettings({ privacy: 'x' })).toEqual(DEFAULT_TELEMETRY_SETTINGS)
  })
})

describe('createTelemetry', () => {
  it('sends nothing while every category is off', async () => {
    const h = harness()
    const t = create(h)
    t.error(boom())
    t.count('features', 'command', 'pane.split')
    t.count('agents', 'bus_message')
    await t.flush()
    await t.shutdown()
    expect(h.sent).toEqual([])
    expect(t.reports()).toEqual({ queued: [], sent: [] })
  })

  it('queues an error report and sends it as one capture batch with the project key', async () => {
    const h = harness(only('errors'))
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
    expect(h.sent[0].headers['Content-Type']).toBe('application/json')
    expect(h.sent[0].headers['User-Agent']).toBe('ostia/1.0.0')
    expect(h.sent[0].body).not.toContain('ghp_')
    expect(h.sent[0].body).not.toContain('/home/ann')
    expect(JSON.parse(h.sent[0].body).api_key).toBe('phc_test')
    const [event] = batchEvents(h.sent[0].body)
    expect(event.event).toBe('$exception')
    expect(event.distinct_id).toBe(t.state().installId)
    expect(event.properties.$process_person_profile).toBe(false)
    expect(event.properties.$ip).toBeUndefined()
    expect(event.properties.$exception_list?.[0].value).toBe('token [redacted] in <path>')
    expect(event.properties.channel).toBe('source')
    expect(t.reports().queued).toEqual([])
    expect(t.reports().sent).toEqual([event])
  })

  it('carries only the enabled categories in the usage event, namespaced', async () => {
    const h = harness(only('usage', 'terminal'))
    let now = 1_000_000
    const t = create(h, { now: () => now })
    t.count('features', 'command', 'pane.split')
    t.count('agents', 'bus_message')
    t.count('terminal', 'shell', 'zsh')
    t.count('terminal', 'wake')
    now += 31 * 60_000
    await t.shutdown()
    expect(h.sent).toHaveLength(1)
    const [event] = batchEvents(h.sent[0].body)
    expect(event.event).toBe('usage')
    expect(event.properties['usage.app_starts']).toBe(1)
    expect(event.properties['usage.session_minutes']).toBe(31)
    expect(event.properties['usage.windows']).toBe('1')
    expect(event.properties['usage.workspaces']).toBe('2-3')
    expect(event.properties['usage.restore']).toBe('ok')
    expect(event.properties['terminal.engine']).toBe('xterm')
    expect(event.properties['terminal.gpu']).toBe('on')
    expect(event.properties['terminal.shell.zsh']).toBe(1)
    expect(event.properties['terminal.wake']).toBe(1)
    const keys = Object.keys(event.properties)
    expect(keys.some((k) => k.startsWith('features.'))).toBe(false)
    expect(keys.some((k) => k.startsWith('agents.'))).toBe(false)
    expect(keys.some((k) => k.startsWith('extensions.'))).toBe(false)
    expect(event.properties.$exception_list).toBeUndefined()
  })

  it('reports the app start once per launch, not again on the next interval', async () => {
    const h = harness(only('usage'))
    vi.useFakeTimers()
    const t = create(h, { endpoint: null, usageIntervalMs: 60_000 })
    vi.advanceTimersByTime(60_000)
    vi.advanceTimersByTime(60_000)
    const [first, second] = t.reports().queued.map((r) => r.properties as Record<string, unknown>)
    expect(first['usage.app_starts']).toBe(1)
    expect(second['usage.app_starts']).toBeUndefined()
    expect(second['usage.session_minutes']).toBe(1)
  })

  it('counts only for a category that is on, and only known keys and ids', async () => {
    const h = harness(only('features', 'extensions', 'agents'))
    const t = create(h)
    t.count('features', 'command', 'pane.split')
    t.count('features', 'command', 'pane.split')
    t.count('features', 'command', 'bad id with spaces')
    t.count('features', 'nope', 'x')
    t.count('features', 'command')
    t.count('terminal', 'wake')
    t.count('agents', 'session', 'claude')
    t.count('agents', 'bus_message', 'extra')
    t.count('nope' as never, 'x')
    await t.shutdown()
    const [event] = batchEvents(h.sent[0].body)
    expect(event.properties['features.command.pane.split']).toBe(2)
    expect(event.properties['agents.session.claude']).toBe(1)
    expect(event.properties['extensions.installed']).toEqual(['trellis'])
    expect(event.properties['extensions.enabled']).toEqual(['trellis'])
    expect(event.properties['agents.bus_message']).toBeUndefined()
    expect(Object.keys(event.properties).some((k) => k.startsWith('terminal.'))).toBe(false)
    expect(Object.keys(event.properties).some((k) => k.includes('nope'))).toBe(false)
    expect(Object.keys(event.properties).some((k) => k.includes('bad id'))).toBe(false)
  })

  it('persists the queue and the install id in a 0600 file and reloads them', async () => {
    const h = harness(only('errors'))
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
    const h = harness(only('errors'))
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

  it('drops queued reports of a category that turned off, keeping the rest of a usage event', async () => {
    const h = harness(only('errors', 'usage', 'agents'))
    vi.useFakeTimers()
    const t = create(h, { endpoint: null, usageIntervalMs: 60_000 })
    t.error(boom())
    t.count('agents', 'bus_message')
    vi.advanceTimersByTime(60_000)
    expect(t.reports().queued.map((r) => r.event)).toEqual(['$exception', 'usage'])
    h.settings = only('usage', 'agents')
    t.settingsChanged()
    expect(t.reports().queued.map((r) => r.event)).toEqual(['usage'])
    h.settings = only('agents')
    t.settingsChanged()
    const [usage] = t.reports().queued
    const properties = usage.properties as Record<string, unknown>
    expect(properties['agents.bus_message']).toBe(1)
    expect(properties['usage.app_starts']).toBeUndefined()
    h.settings = DEFAULT_TELEMETRY_SETTINGS
    t.settingsChanged()
    expect(t.reports().queued).toEqual([])
  })

  it('reset gives a new install id and forgets every report', async () => {
    const h = harness(only('errors'))
    const t = create(h)
    t.error(boom())
    await t.flush()
    const before = t.state().installId
    const after = t.resetInstallId()
    expect(after).not.toBe(before)
    expect(t.state().installId).toBe(after)
    expect(t.reports()).toEqual({ queued: [], sent: [] })
  })

  it('remembers the consent answer and marks a category added later as new, never re-asking', () => {
    const h = harness()
    const t = create(h)
    expect(t.state().asked).toBe(false)
    expect(t.state().newCategories).toEqual([])
    t.consented()
    const file = JSON.parse(readFileSync(h.file, 'utf8'))
    expect(file.asked).toBe(true)
    expect(typeof file.answeredAt).toBe('string')
    file.seen = file.seen.filter((c: string) => c !== 'terminal')
    writeFileSync(h.file, JSON.stringify(file))
    const later = create(h)
    expect(later.state().asked).toBe(true)
    expect(later.state().newCategories).toEqual(['terminal'])
    expect(readTelemetrySettings({ privacy: { telemetry: { errors: true } } }).terminal).toBe(false)
    later.categoriesSeen()
    expect(create(h).state().newCategories).toEqual([])
  })

  it('drops a corrupt queue entry instead of failing every flush', async () => {
    const h = harness(only('errors'))
    const t = create(h)
    t.error(boom())
    const file = JSON.parse(readFileSync(h.file, 'utf8'))
    file.queue.push({ report: null, attempts: 0 }, { report: { event: '$exception' }, attempts: 0 })
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

  it('never contacts the network without an endpoint', async () => {
    const h = harness(only('errors'))
    const t = create(h, { endpoint: null })
    t.error(boom())
    await t.flush()
    await t.shutdown()
    expect(h.sent).toEqual([])
    expect(t.reports().queued).toHaveLength(1)
  })
})

describe('sendBatch over http', () => {
  let server: Server
  let url: string
  const received: Array<{ path: string | undefined; body: string }> = []

  beforeEach(async () => {
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        received.push({ path: req.url, body })
        res.writeHead(200).end('{}')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    url = `http://phc_e2e@127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('posts the batch to the ingest host', async () => {
    const h = harness(only('errors'))
    const t = create(h, {
      endpoint: telemetryEndpoint(false, { [envName(TELEMETRY_URL_ENV)]: url }, undefined),
      fetchFn: undefined,
    })
    t.error(boom())
    await t.flush()
    expect(received).toHaveLength(1)
    expect(received[0].path).toBe('/batch/')
    expect(JSON.parse(received[0].body).api_key).toBe('phc_e2e')
    expect(batchEvents(received[0].body)[0].properties.$exception_list?.[0].value).toBe('boom')
  })
})

describe('registerTelemetry', () => {
  it('answers state, consent, reset and reports over IPC and validates counts', async () => {
    const t = registerTelemetry({
      file: join(dir, 'telemetry.json'),
      version: '1.0.0',
      stamp: undefined,
      readSettings: () => ({ privacy: { telemetry: { features: true } } }),
      locale: () => 'en',
      session: () => facts,
    })
    const state = (await handlers.get('telemetry:state')?.()) as { installId: string }
    expect(state.installId).toBe(t.state().installId)
    handlers.get('telemetry:count')?.({}, 'features', 'command', 'pane.split')
    handlers.get('telemetry:count')?.({}, 42, 'command', 'pane.split')
    await handlers.get('telemetry:consented')?.()
    expect(t.state().asked).toBe(true)
    await handlers.get('telemetry:categories-seen')?.()
    const next = (await handlers.get('telemetry:reset-id')?.()) as string
    expect(next).not.toBe(state.installId)
    expect(await handlers.get('telemetry:reports')?.()).toEqual({ queued: [], sent: [] })
    await t.shutdown()
  })
})
