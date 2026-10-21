import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SANDBOXED_CONNECTOR } from './connectorHost'
import { closeHarnesses, type HostHarness, hostHarness, settle } from './fakeExt'
import { panelHandlers } from './panelHandlers'
import { graphVerbs } from './verbs'

const SECRET = ['ghp', 'Z'.repeat(36)].join('_')

const graph = (nodes: string) => `version: 1
on: [{ manual: {} }]
start: a
state:
  task: { type: string, default: "hi" }
  answer: { type: string, default: "" }
  err: { type: string, default: "" }
nodes:
${nodes}
edges: []
`

function workspace(files: Record<string, string>, extra: { sandboxed?: boolean } = {}) {
  const workDir = mkdtempSync(join(tmpdir(), 'graphs-connectors-'))
  mkdirSync(join(workDir, '.ostia/graphs'), { recursive: true })
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(workDir, '.ostia/graphs', `${name}.yaml`), text)
  return { workspaceId: 'w1', workDir, kind: 'terminal', ...extra }
}

async function run(h: HostHarness, name: string): Promise<string> {
  const listing = await h.runner.graph('w1', name)
  if (!listing?.entry.loaded) throw new Error(JSON.stringify(listing?.problems))
  expect(await h.runner.enable('w1', name, listing.entry.loaded.fingerprint)).toEqual({ ok: true })
  const res = await h.runner.start('w1', name, { byAgent: false, inputs: [] })
  if (!res.ok || !('runId' in res)) throw new Error(JSON.stringify(res))
  return res.runId
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await closeHarnesses()
})

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    const stat = statSync(path, { throwIfNoEntry: false })
    if (!stat) return []
    if (stat.isDirectory()) return filesUnder(path)
    return stat.isFile() ? [readFileSync(path, 'utf8')] : []
  })
}

async function fakeApi() {
  const seen: IncomingHttpHeaders[] = []
  const server = createServer((req, res) => {
    seen.push(req.headers)
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: 1 }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { seen, baseUrl: `http://127.0.0.1:${port}/api`, close: () => server.close() }
}

describe('connectors in the Ostia host', () => {
  it('calls an MCP tool through ext.mcpCall and puts its text in the state', async () => {
    const h = await hostHarness(
      workspace({
        echo: graph(
          '  - { id: a, kind: connector, with: { use: "mcp:fake/echo", input: { text: "{{state.task}}" } }, out: { data.text: answer } }',
        ),
      }),
    )
    h.mcpReply = () => ({ ok: true, text: 'echo: hi' })
    const id = await run(h, 'echo')
    await settle()
    expect(h.mcpCalls).toEqual([{ server: 'fake', tool: 'echo', input: { text: 'hi' } }])
    expect((await h.run(id))?.state.answer).toBe('echo: hi')
  })

  it('fails with the host message and a catch keeps the run going', async () => {
    const h = await hostHarness(
      workspace({
        off: graph(
          '  - { id: a, kind: connector, with: { use: "mcp:fake/echo" }, out: { error.message: err }, catch: [{ errors: [ConnectorFailed], then: continue }] }',
        ),
      }),
    )
    h.mcpReply = () => ({
      ok: false,
      error: 'mcp-call-failed',
      message: 'This MCP server is not connected.',
    })
    const id = await run(h, 'off')
    await settle()
    expect((await h.run(id))?.status).toBe('done')
    expect((await h.run(id))?.state.err).toContain('This MCP server is not connected.')
  })

  it('a graph with an MCP connector says so and cannot be enabled while Graphs lacks the mcp grant', async () => {
    const h = await hostHarness(
      workspace({ echo: graph('  - { id: a, kind: connector, with: { use: "mcp:fake/echo" } }') }),
    )
    h.runner.setMcpGranted(false)
    const listing = await h.runner.graph('w1', 'echo')
    expect(listing?.problems.map((p) => p.code)).toEqual(['needs-mcp'])
    expect(listing?.problems[0]?.message).toContain('Settings')
    expect(
      await h.runner.enable('w1', 'echo', listing?.entry.loaded?.fingerprint ?? ''),
    ).toMatchObject({
      ok: false,
      error: 'needs-mcp',
    })
    h.runner.setMcpGranted(true)
    expect((await h.runner.graph('w1', 'echo'))?.problems).toEqual([])
  })

  it('ostia graph nodes lists no connectors and asks for no MCP server for a sandboxed or scratch caller', async () => {
    const h = await hostHarness(workspace({}))
    await h.runner.setWorkspaces([
      { workspaceId: 'w1', workDir: h.workspace.workDir, kind: 'terminal' },
      { workspaceId: 'sc', workDir: h.workspace.workDir, kind: 'scratch' },
    ])
    let asked = 0
    const ext = {
      mcpServers: async () => {
        asked++
        return {
          ok: true as const,
          servers: [{ name: 'fake', state: 'ready' as const, tools: ['echo'] }],
        }
      },
      connections: async () => ({
        ok: true as const,
        connections: [{ name: 'api', kind: 'http' }],
      }),
    }
    const verbs = graphVerbs(h.runner, async () => {}, ext)
    const listing = async (caller: Record<string, unknown>) => {
      const res = (await verbs.nodes?.({}, {
        kind: 'pane',
        capabilities: [],
        ...caller,
      } as never)) as {
        text: string
      }
      return (JSON.parse(res.text) as { kind: string; connectors?: unknown }[]).find(
        (k) => k.kind === 'connector',
      )?.connectors
    }
    expect(await listing({ workspaceId: 'w1' })).toMatchObject({ mcp: [{ server: 'fake' }] })
    expect(asked).toBe(1)
    expect(await listing({ workspaceId: 'w1', sandboxed: true })).toEqual({ refused: 'sandboxed' })
    expect(await listing({ workspaceId: 'sc' })).toEqual({ refused: 'scratch' })
    expect(asked).toBe(1)
  })

  it('refuses a connector in a sandboxed workspace', async () => {
    const h = await hostHarness(
      workspace(
        { boxed: graph('  - { id: a, kind: connector, with: { use: "mcp:fake/echo" } }') },
        { sandboxed: true },
      ),
    )
    const listing = await h.runner.graph('w1', 'boxed')
    expect(listing?.problems).toEqual([
      { code: 'sandboxed', message: SANDBOXED_CONNECTOR, node: 'a' },
    ])
    expect(
      await h.runner.enable('w1', 'boxed', listing?.entry.loaded?.fingerprint ?? ''),
    ).toMatchObject({
      ok: false,
      error: 'sandboxed',
    })
  })

  it('a connection that was not made is unknown-connection until the human makes it', async () => {
    const h = await hostHarness(
      workspace({
        api: graph(
          '  - { id: a, kind: connector, with: { use: "http.request", connection: api, input: { path: "/x" } } }',
        ),
      }),
    )
    expect((await h.runner.graph('w1', 'api'))?.problems.map((p) => p.code)).toEqual([
      'unknown-connection',
    ])
    h.runner.setConnections([{ name: 'api', kind: 'http' }])
    expect((await h.runner.graph('w1', 'api'))?.problems).toEqual([])
  })

  it('GRF-C179 the Enable view warns about a secret-shaped input and says which nodes write', async () => {
    const h = await hostHarness(
      workspace({
        api: graph(
          [
            `  - { id: a, kind: connector, with: { use: "http.request", connection: api, input: { method: POST, path: "/x", body: { token: "${SECRET}" } } } }`,
            '  - { id: b, kind: connector, with: { use: "http.request", connection: api, input: { path: "/y" } } }',
          ].join('\n'),
        ).replace('edges: []', 'edges: [{ from: a, to: b }]'),
      }),
    )
    h.runner.setConnections([{ name: 'api', kind: 'http' }])
    h.ext.redact = async (texts) => texts.map((t) => t.replace(SECRET, '[redacted:github]'))
    const handlers = panelHandlers(
      h.runner,
      { ...h.ext, focusPane: async () => ({ ok: true }) },
      async () => {},
    )
    const res = await handlers.definition?.({ workspaceId: 'w1', name: 'api' })
    const def = (res as { data: { connectorUses: unknown[] } }).data
    expect(def.connectorUses).toEqual([
      { node: 'a', use: 'http.request', connection: 'api', effect: 'write', secretShaped: true },
      { node: 'b', use: 'http.request', connection: 'api', effect: 'read', secretShaped: false },
    ])
  })

  it('GRF-C210 a connection secret, its fields and the extension token never reach the runtime, its journal or its log', async () => {
    const OSTIA_SECRET = ['ostia', 'token', 'Q'.repeat(24)].join('-')
    vi.stubEnv('OSTIA_TOKEN', OSTIA_SECRET)
    const api = await fakeApi()
    const received: Buffer[] = []
    const logged: string[] = []
    try {
      const h = await hostHarness(
        workspace({
          both: graph(
            [
              '  - { id: a, kind: connector, with: { use: "http.request", connection: api, input: { path: "/x" } } }',
              '  - { id: b, kind: connector, with: { use: "mcp:fake/echo", input: { text: "{{state.task}}" } }, out: { data.text: answer } }',
            ].join('\n'),
          ).replace('edges: []', 'edges: [{ from: a, to: b }]'),
        }),
        undefined,
        undefined,
        { received, log: (line) => logged.push(line) },
      )
      h.connections = [
        {
          name: 'api',
          kind: 'http',
          fields: { baseUrl: api.baseUrl, auth: 'bearer' },
          secrets: { secret: SECRET },
        },
      ]
      h.runner.setConnections([{ name: 'api', kind: 'http' }])
      h.mcpReply = () => ({ ok: true, text: 'echoed' })
      const id = await run(h, 'both')
      await settle()
      expect((await h.run(id))?.status).toBe('done')
      expect(api.seen.map((headers) => headers.authorization)).toEqual([`Bearer ${SECRET}`])
      const everything = [
        Buffer.concat(received).toString('utf8'),
        ...filesUnder(h.runtime.paths.data),
        ...logged,
      ].join('\n')
      expect(Buffer.concat(received).toString('utf8')).toContain('echoed')
      for (const kept of [SECRET, api.baseUrl, '127.0.0.1', 'bearer', OSTIA_SECRET, 'OSTIA_'])
        expect(everything).not.toContain(kept)
    } finally {
      api.close()
    }
  })
})
