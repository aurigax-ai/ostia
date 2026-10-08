import { connect } from 'node:net'
import { Agent, setGlobalDispatcher } from 'undici'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FAKE_MCP_SERVER,
  type FakeMcpHttp,
  startFakeMcpHttp,
} from '../../test/fixtures/mcp/startHttpServer'
import type { McpServerSettings, McpServerStatus } from '../shared/chatTools'
import { en } from '../shared/dict'
import { signInToMcp, signOutOfMcp } from './chatToolsIpc'
import type { ExtensionSecretStore } from './extensionHost'
import type { StoredSecrets } from './extensionSecrets'
import { McpHost } from './mcpHost'
import { McpOAuth, type McpOAuthBrowser } from './mcpOAuth'
import { MCP_OAUTH_KEY, createMcpOAuthStore } from './mcpOAuthStore'

function refusesConnections(url: string): Promise<boolean> {
  const { hostname, port } = new URL(url)
  return new Promise((resolve) => {
    const socket = connect({ host: hostname, port: Number(port) })
    socket.on('connect', () => {
      socket.destroy()
      resolve(false)
    })
    socket.on('error', () => resolve(true))
  })
}

function http(url: string, overrides: Partial<McpServerSettings> = {}): McpServerSettings {
  return {
    name: 'remote',
    enabled: true,
    url,
    env: {},
    secrets: [],
    disabledTools: [],
    ...overrides,
  }
}

const noSecrets: ExtensionSecretStore = {
  keys: () => [],
  get: () => null,
  set: () => ({ ok: true }),
}

const fakes: FakeMcpHttp[] = []
setGlobalDispatcher(new Agent())

const hosts: McpHost[] = []
const oauths: McpOAuth[] = []

afterEach(() => {
  for (const o of oauths.splice(0)) o.closeAll()
  for (const h of hosts.splice(0)) h.closeAll()
  for (const f of fakes.splice(0)) f.close()
})

async function fake(opts: { oauth?: boolean } = { oauth: true }): Promise<FakeMcpHttp> {
  const server = await startFakeMcpHttp(opts)
  fakes.push(server)
  return server
}

function setup(
  servers: McpServerSettings[],
  opts: { browser?: McpOAuthBrowser; timeoutMs?: number; now?: () => number } = {},
) {
  let current = servers
  let file: StoredSecrets = {}
  const opened: string[] = []
  const store = createMcpOAuthStore({
    load: () => file,
    save: (data) => {
      file = JSON.parse(JSON.stringify(data)) as StoredSecrets
    },
    canEncrypt: () => true,
    encrypt: (plain) => Buffer.from(`enc:${plain}`).toString('base64'),
    decrypt: (secret) => Buffer.from(secret, 'base64').toString().slice(4),
  })
  const updates: McpServerStatus[][] = []
  const oauth: McpOAuth = new McpOAuth({
    store,
    openExternal: (url) => {
      opened.push(url)
      return true
    },
    browser: opts.browser ?? 'fetch',
    pages: () => en.native.signIn,
    onChange: () => host.notify(),
    timeoutMs: opts.timeoutMs,
    connectTimeoutMs: 10_000,
    now: opts.now,
  })
  const host: McpHost = new McpHost({
    servers: () => current,
    secret: () => null,
    onStatus: (status) => updates.push(status),
    auth: oauth,
    connectTimeoutMs: 10_000,
  })
  hosts.push(host)
  oauths.push(oauth)
  const deps = {
    settings: () => ({ mcpServers: current, skillFolders: [] }),
    mcp: host,
    secrets: noSecrets,
    oauth,
  }
  return {
    host,
    oauth,
    store,
    opened,
    updates,
    deps,
    stored: () => file,
    setServers: (next: McpServerSettings[]) => {
      current = next
    },
  }
}

async function waitFor(host: McpHost, state: string): Promise<McpServerStatus> {
  const deadline = Date.now() + 15_000
  for (;;) {
    const status = host.status()[0]
    if (status?.state === state) return status
    if (Date.now() > deadline) throw new Error(`timed out; last ${JSON.stringify(status)}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('MCP OAuth sign-in against the fake protected server', () => {
  it('marks a server that answers 401 as needing sign-in without registering or opening anything', async () => {
    const server = await fake()
    const { host, opened } = setup([http(server.url)])
    host.refresh()
    const failed = await waitFor(host, 'error')
    expect(failed.auth).toBe('required')
    expect(opened).toEqual([])
    expect(await server.stats()).toMatchObject({ registrations: 0, authorizations: 0 })
  })

  it('signs in, stores the tokens encrypted and connects with them', async () => {
    const server = await fake()
    const { host, deps, store, stored, updates } = setup([http(server.url)])
    expect(await signInToMcp(deps, 'remote')).toEqual({ ok: true })
    const ready = await waitFor(host, 'ready')
    expect(ready.auth).toBe('signed-in')
    expect(ready.tools.map((t) => t.name)).toEqual(['echo', 'env', 'fail', 'slow', 'exit'])
    expect(await host.call('c1', 'remote', 'echo', { text: 'hi' })).toEqual({
      ok: true,
      output: 'echo: hi',
    })
    expect(await server.stats()).toMatchObject({
      registrations: 1,
      authorizations: 1,
      exchanges: 1,
    })

    const record = store.get('remote', server.url)
    expect(record?.tokens?.access_token).toEqual(expect.any(String))
    expect(record?.tokens?.refresh_token).toEqual(expect.any(String))
    expect(record?.expiresAt).toBeGreaterThan(Date.now())
    expect(record?.client.client_id).toMatch(/^client-/)
    expect(record?.redirectUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)

    const onDisk = JSON.stringify(stored())
    expect(Object.keys(stored().remote)).toEqual([MCP_OAUTH_KEY])
    expect(onDisk).not.toContain(record?.tokens?.access_token)
    expect(JSON.stringify(updates)).not.toContain(record?.tokens?.access_token)
    expect(JSON.stringify(updates)).not.toContain(record?.client.client_id)
    expect(updates.some((u) => u[0].auth === 'signing-in')).toBe(true)
  })

  it('refreshes an expired access token in main and keeps the server connected', async () => {
    const server = await fake()
    const { host, deps, store } = setup([http(server.url)])
    await signInToMcp(deps, 'remote')
    await waitFor(host, 'ready')
    const before = store.get('remote', server.url)?.tokens
    await server.control('expire')
    expect(await host.call('c1', 'remote', 'echo', { text: 'again' })).toEqual({
      ok: true,
      output: 'echo: again',
    })
    const after = store.get('remote', server.url)?.tokens
    expect(after?.access_token).not.toBe(before?.access_token)
    expect(after?.refresh_token).not.toBe(before?.refresh_token)
    expect(await server.stats()).toMatchObject({ refreshes: 1, authorizations: 1 })
    expect(host.status()[0]).toMatchObject({ state: 'ready', auth: 'signed-in' })
  })

  it('shows expired when the refresh token is refused, drops the tokens and opens no browser', async () => {
    const server = await fake()
    const { host, deps, store, opened } = setup([http(server.url)])
    await signInToMcp(deps, 'remote')
    await waitFor(host, 'ready')
    await server.control('revoke')
    expect(await host.call('c1', 'remote', 'echo', { text: 'hi' })).toMatchObject({ ok: false })
    const failed = await waitFor(host, 'error')
    expect(failed.auth).toBe('expired')
    expect(store.get('remote', server.url)?.tokens).toBeUndefined()
    expect(opened).toEqual([])
    expect(await server.stats()).toMatchObject({ authorizations: 1, registrations: 1 })

    expect(await signInToMcp(deps, 'remote')).toEqual({ ok: true })
    expect((await waitFor(host, 'ready')).auth).toBe('signed-in')
  })

  it('shows expired once an access token without a refresh token is past its expiry', async () => {
    const server = await fake()
    let now = Date.now()
    const { host, deps, store } = setup([http(server.url)], { now: () => now })
    await signInToMcp(deps, 'remote')
    const record = store.get('remote', server.url)
    if (!record?.tokens) throw new Error('not signed in')
    const { refresh_token: _dropped, ...tokens } = record.tokens
    store.set('remote', { ...record, tokens })
    expect(host.status()[0].auth).toBe('signed-in')
    now += 3601 * 1000
    expect(host.status()[0].auth).toBe('expired')
  })

  it('signs out by deleting the tokens and reconnecting without them', async () => {
    const server = await fake()
    const { host, deps, stored } = setup([http(server.url)])
    await signInToMcp(deps, 'remote')
    await waitFor(host, 'ready')
    signOutOfMcp(deps, 'remote')
    expect(stored()).toEqual({})
    const failed = await waitFor(host, 'error')
    expect(failed.auth).toBe('required')
  })

  it('drops the tokens when the server URL changes or the server is removed', async () => {
    const server = await fake()
    const other = await fake()
    const { host, deps, stored, setServers } = setup([http(server.url)])
    await signInToMcp(deps, 'remote')
    await waitFor(host, 'ready')
    setServers([http(other.url)])
    host.refresh()
    expect(stored()).toEqual({})
    expect((await waitFor(host, 'error')).auth).toBe('required')

    await signInToMcp(deps, 'remote')
    expect(Object.keys(stored())).toEqual(['remote'])
    setServers([])
    host.refresh()
    expect(stored()).toEqual({})
  })

  it('opens the authorization URL in the system browser and accepts only the callback with its state', async () => {
    const server = await fake()
    const { deps, opened, host } = setup([http(server.url)], { browser: 'system' })
    const pending = signInToMcp(deps, 'remote')
    await until(() => opened.length === 1)
    const authorization = new URL(opened[0])
    expect(authorization.origin).toBe(server.origin)
    expect(authorization.pathname).toBe('/authorize')
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorization.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(authorization.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const redirect = new URL(authorization.searchParams.get('redirect_uri') ?? '')
    expect(redirect.hostname).toBe('127.0.0.1')
    expect(host.status()[0].auth).toBe('signing-in')
    expect(await signInToMcp(deps, 'remote')).toEqual({ ok: false, error: 'in-progress' })

    const forged = new URL(redirect)
    forged.searchParams.set('code', 'stolen')
    forged.searchParams.set('state', 'not-the-state')
    const once = { headers: { connection: 'close' } }
    expect((await fetch(forged, once)).status).toBe(400)
    expect((await fetch(new URL('/other', redirect), once)).status).toBe(404)

    const granted = await fetch(authorization, { redirect: 'manual' })
    const callback = await fetch(granted.headers.get('location') ?? '', once)
    expect(callback.status).toBe(200)
    expect(await callback.text()).toContain('Signed in')
    expect(await pending).toEqual({ ok: true })
    expect(await refusesConnections(redirect.href)).toBe(true)
  })

  it('reports the exact reason when the human is refused at the authorization server', async () => {
    const server = await fake()
    await server.control('deny')
    const { deps, stored } = setup([http(server.url)])
    expect(await signInToMcp(deps, 'remote')).toEqual({
      ok: false,
      error: 'failed',
      detail: 'access_denied: The fake human said no',
    })
    expect(stored()).toEqual({})
  })

  it('times out, and cancels, without storing anything and closes its listener', async () => {
    const server = await fake()
    const timed = setup([http(server.url)], { browser: 'system', timeoutMs: 150 })
    expect(await signInToMcp(timed.deps, 'remote')).toEqual({ ok: false, error: 'timeout' })
    const redirect = new URL(timed.opened[0]).searchParams.get('redirect_uri') ?? ''
    expect(await refusesConnections(redirect)).toBe(true)
    expect(timed.stored()).toEqual({})

    const cancelled = setup([http(server.url)], { browser: 'system' })
    const pending = signInToMcp(cancelled.deps, 'remote')
    await until(() => cancelled.opened.length === 1)
    cancelled.oauth.cancel('remote')
    expect(await pending).toEqual({ ok: false, error: 'cancelled' })
    expect(cancelled.stored()).toEqual({})
    expect(cancelled.host.status()[0].auth).not.toBe('signing-in')
  })

  it('refuses a server that needs no sign-in, a command server and an unknown one', async () => {
    const open = await fake({ oauth: false })
    const { deps } = setup([
      http(open.url),
      { name: 'local', enabled: true, command: ['node'], env: {}, secrets: [], disabledTools: [] },
    ])
    expect(await signInToMcp(deps, 'remote')).toEqual({ ok: false, error: 'not-needed' })
    expect(await signInToMcp(deps, 'local')).toEqual({ ok: false, error: 'not-http' })
    expect(await signInToMcp(deps, 'nope')).toEqual({ ok: false, error: 'unknown-server' })
  })
})

describe('McpHost.test', () => {
  it('connects, counts the tools and leaves the server state alone', async () => {
    const server = await fake()
    const { host, deps, setServers } = setup([http(server.url)])
    const refused = await host.test('remote')
    expect(refused).toMatchObject({ ok: false })
    expect(refused.ok ? '' : refused.error).toContain('401')
    expect(host.status()[0].state).toBe('idle')
    expect(await server.stats()).toMatchObject({ registrations: 0 })

    await signInToMcp(deps, 'remote')
    expect(await host.test('remote')).toEqual({ ok: true, tools: 5 })

    setServers([
      {
        name: 'local',
        enabled: false,
        command: [process.execPath, FAKE_MCP_SERVER],
        env: {},
        secrets: [],
        disabledTools: [],
      },
      {
        name: 'missing',
        enabled: true,
        command: ['/nonexistent/ostia-mcp-server'],
        env: {},
        secrets: [],
        disabledTools: [],
      },
    ])
    expect(await host.test('local')).toEqual({ ok: true, tools: 5 })
    expect(await host.test('missing')).toMatchObject({ ok: false })
    expect(await host.test('nope')).toEqual({ ok: false, error: 'unknown-server' })
  })
})
