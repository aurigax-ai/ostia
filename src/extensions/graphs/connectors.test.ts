import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { settle } from '@aurigax-ai/graph/testing'
import { describe, expect, it } from 'vitest'
import { SANDBOXED_CONNECTOR } from './connectorHost'
import { type HostHarness, hostHarness } from './fakeExt'
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

function run(h: HostHarness, name: string): string {
  const listing = h.runner.graph('w1', name)
  if (!listing?.entry.loaded) throw new Error(JSON.stringify(listing?.problems))
  expect(h.runner.enable('w1', name, listing.entry.loaded.fingerprint)).toEqual({ ok: true })
  const res = h.runner.start('w1', name, { byAgent: false, inputs: [] })
  if (!res.ok || !('runId' in res)) throw new Error(JSON.stringify(res))
  return res.runId
}

describe('connectors in the Ostia host', () => {
  it('calls an MCP tool through ext.mcpCall and puts its text in the state', async () => {
    const h = hostHarness(
      workspace({
        echo: graph(
          '  - { id: a, kind: connector, with: { use: "mcp:fake/echo", input: { text: "{{state.task}}" } }, out: { data.text: answer } }',
        ),
      }),
    )
    h.mcpReply = () => ({ ok: true, text: 'echo: hi' })
    const id = run(h, 'echo')
    await settle()
    expect(h.mcpCalls).toEqual([{ server: 'fake', tool: 'echo', input: { text: 'hi' } }])
    expect(h.runner.engine.run(id)?.state.state.answer).toBe('echo: hi')
  })

  it('fails with the host message and a catch keeps the run going', async () => {
    const h = hostHarness(
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
    const id = run(h, 'off')
    await settle()
    expect(h.runner.engine.run(id)?.state.status).toBe('done')
    expect(h.runner.engine.run(id)?.state.state.err).toContain('This MCP server is not connected.')
  })

  it('a graph with an MCP connector says so and cannot be enabled while Graphs lacks the mcp grant', () => {
    const h = hostHarness(
      workspace({ echo: graph('  - { id: a, kind: connector, with: { use: "mcp:fake/echo" } }') }),
    )
    h.runner.setMcpGranted(false)
    const listing = h.runner.graph('w1', 'echo')
    expect(listing?.problems.map((p) => p.code)).toEqual(['needs-mcp'])
    expect(listing?.problems[0]?.message).toContain('Settings')
    expect(h.runner.enable('w1', 'echo', listing?.entry.loaded?.fingerprint ?? '')).toMatchObject({
      ok: false,
      error: 'needs-mcp',
    })
    h.runner.setMcpGranted(true)
    expect(h.runner.graph('w1', 'echo')?.problems).toEqual([])
  })

  it('ostia graph nodes lists no connectors and asks for no MCP server for a sandboxed or scratch caller', async () => {
    const h = hostHarness(workspace({}))
    h.runner.setWorkspaces([
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

  it('refuses a connector in a sandboxed workspace', () => {
    const h = hostHarness(
      workspace(
        { boxed: graph('  - { id: a, kind: connector, with: { use: "mcp:fake/echo" } }') },
        { sandboxed: true },
      ),
    )
    const listing = h.runner.graph('w1', 'boxed')
    expect(listing?.problems).toEqual([
      { code: 'sandboxed', message: SANDBOXED_CONNECTOR, node: 'a' },
    ])
    expect(h.runner.enable('w1', 'boxed', listing?.entry.loaded?.fingerprint ?? '')).toMatchObject({
      ok: false,
      error: 'sandboxed',
    })
  })

  it('a connection that was not made is unknown-connection until the human makes it', () => {
    const h = hostHarness(
      workspace({
        api: graph(
          '  - { id: a, kind: connector, with: { use: "http.request", connection: api, input: { path: "/x" } } }',
        ),
      }),
    )
    expect(h.runner.graph('w1', 'api')?.problems.map((p) => p.code)).toEqual(['unknown-connection'])
    h.runner.setConnections([{ name: 'api', kind: 'http' }])
    expect(h.runner.graph('w1', 'api')?.problems).toEqual([])
  })

  it('GRF-C179 the Enable view warns about a secret-shaped input and says which nodes write', async () => {
    const h = hostHarness(
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
})
