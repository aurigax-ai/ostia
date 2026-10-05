import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { McpServerSettings, McpServerStatus } from '../shared/chatTools'
import { setMcpSecret } from './chatToolsIpc'
import type { ExtensionSecretStore } from './extensionHost'
import { McpHost, formatCallResult } from './mcpHost'

const FAKE_SERVER = join(__dirname, '../../test/fixtures/mcp/fake-server.mjs')

function server(overrides: Partial<McpServerSettings> = {}): McpServerSettings {
  return {
    name: 'fake',
    enabled: true,
    command: [process.execPath, FAKE_SERVER],
    env: {},
    secrets: [],
    disabledTools: [],
    ...overrides,
  }
}

function memorySecrets(): ExtensionSecretStore & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    keys: (ns) =>
      [...data.keys()].filter((k) => k.startsWith(`${ns}/`)).map((k) => k.slice(ns.length + 1)),
    get: (ns, key) => data.get(`${ns}/${key}`) ?? null,
    set: (ns, key, value) => {
      if (value === null) data.delete(`${ns}/${key}`)
      else data.set(`${ns}/${key}`, value)
      return { ok: true }
    },
  }
}

const hosts: McpHost[] = []

afterEach(() => {
  for (const h of hosts.splice(0)) h.closeAll()
})

function start(servers: McpServerSettings[], secrets = memorySecrets()) {
  let current = servers
  const updates: McpServerStatus[][] = []
  const host = new McpHost({
    servers: () => current,
    secret: (ns, key) => secrets.get(ns, key),
    onStatus: (status) => updates.push(status),
    connectTimeoutMs: 10_000,
  })
  hosts.push(host)
  return {
    host,
    secrets,
    updates,
    setServers: (next: McpServerSettings[]) => {
      current = next
    },
  }
}

async function waitFor(host: McpHost, name: string, state: string): Promise<McpServerStatus> {
  const deadline = Date.now() + 15_000
  for (;;) {
    const status = host.status().find((s) => s.name === name)
    if (status?.state === state) return status
    if (Date.now() > deadline) throw new Error(`timed out; last ${JSON.stringify(status)}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe('McpHost against the fake stdio MCP server', () => {
  it('stays idle until refreshed, then connects and lists the tools', async () => {
    const { host } = start([server()])
    expect(host.status()[0].state).toBe('idle')
    host.refresh()
    const ready = await waitFor(host, 'fake', 'ready')
    expect(ready.tools.map((t) => t.name)).toEqual(['echo', 'env', 'fail', 'slow', 'exit'])
    expect(ready.tools[0].inputSchema).toMatchObject({ type: 'object' })
  })

  it('calls a tool, reports a tool error, and refuses a tool the human turned off', async () => {
    const { host, setServers } = start([server()])
    host.refresh()
    await waitFor(host, 'fake', 'ready')
    expect(await host.call('c1', 'fake', 'echo', { text: 'hi' })).toEqual({
      ok: true,
      output: 'echo: hi',
    })
    expect(await host.call('c2', 'fake', 'fail', {})).toEqual({ ok: false, error: 'boom' })
    setServers([server({ disabledTools: ['echo'] })])
    expect(await host.call('c3', 'fake', 'echo', { text: 'hi' })).toMatchObject({ ok: false })
    expect(await host.call('bad id!', 'fake', 'env', {})).toMatchObject({ ok: false })
  })

  it('gives the server only its env and secrets, not the parent environment', async () => {
    process.env.OSTIA_MCP_LEAK_CHECK = 'leaked'
    const secrets = memorySecrets()
    secrets.set('fake', 'API_TOKEN', 's3cret')
    const { host } = start([server({ env: { PLAIN: 'visible' }, secrets: ['API_TOKEN'] })], secrets)
    host.refresh()
    await waitFor(host, 'fake', 'ready')
    expect(await host.call('e1', 'fake', 'env', { name: 'PLAIN' })).toEqual({
      ok: true,
      output: 'visible',
    })
    expect(await host.call('e2', 'fake', 'env', { name: 'API_TOKEN' })).toEqual({
      ok: true,
      output: 's3cret',
    })
    expect(await host.call('e3', 'fake', 'env', { name: 'OSTIA_MCP_LEAK_CHECK' })).toEqual({
      ok: true,
      output: '(unset)',
    })
    expect(host.status()[0].secretsSet).toEqual(['API_TOKEN'])
    Reflect.deleteProperty(process.env, 'OSTIA_MCP_LEAK_CHECK')
  })

  it('cancels an in-flight call', async () => {
    const { host } = start([server()])
    host.refresh()
    await waitFor(host, 'fake', 'ready')
    const pending = host.call('slow1', 'fake', 'slow', { ms: 5000 })
    await new Promise((r) => setTimeout(r, 100))
    host.cancel('slow1')
    expect(await pending).toEqual({ ok: false, error: 'cancelled' })
  })

  it('shows an error when the server exits or cannot start', async () => {
    const { host } = start([
      server(),
      server({ name: 'missing', command: ['/nonexistent/ostia-mcp-server'] }),
    ])
    host.refresh()
    await waitFor(host, 'fake', 'ready')
    await waitFor(host, 'missing', 'error')
    void host.call('x1', 'fake', 'exit', {})
    const exited = await waitFor(host, 'fake', 'error')
    expect(exited.error).toBeTruthy()
  })

  it('drops a server the human turned off', async () => {
    const { host, setServers } = start([server()])
    host.refresh()
    await waitFor(host, 'fake', 'ready')
    setServers([server({ enabled: false })])
    expect(host.refresh()[0]).toMatchObject({ state: 'off', tools: [] })
    expect(await host.call('o1', 'fake', 'echo', { text: 'x' })).toMatchObject({ ok: false })
  })
})

describe('setMcpSecret', () => {
  it('stores only secrets the human declared on a configured server', () => {
    const secrets = memorySecrets()
    const { host } = start([server({ secrets: ['TOKEN'] })], secrets)
    const deps = {
      settings: () => ({ mcpServers: [server({ secrets: ['TOKEN'] })], skillFolders: [] }),
      mcp: host,
      secrets,
    }
    expect(setMcpSecret(deps, 'fake', 'TOKEN', 'v')).toEqual({ ok: true })
    expect(secrets.get('fake', 'TOKEN')).toBe('v')
    expect(setMcpSecret(deps, 'fake', 'OTHER', 'v')).toMatchObject({ ok: false })
    expect(setMcpSecret(deps, 'nope', 'TOKEN', 'v')).toMatchObject({ ok: false })
    expect(setMcpSecret(deps, 'fake', '__proto__', 'v')).toMatchObject({ ok: false })
    expect(setMcpSecret(deps, 'fake', 'TOKEN', null)).toEqual({ ok: true })
    expect(secrets.get('fake', 'TOKEN')).toBeNull()
  })
})

describe('formatCallResult', () => {
  it('joins text, names other content and clips', () => {
    expect(
      formatCallResult({
        content: [
          { type: 'text', text: 'a' },
          { type: 'image', data: 'x', mimeType: 'image/png' },
        ],
      }),
    ).toEqual({ ok: true, output: 'a\n[image omitted]' })
    expect(formatCallResult({ content: [], structuredContent: { n: 1 } })).toEqual({
      ok: true,
      output: '{"n":1}',
    })
  })
})
