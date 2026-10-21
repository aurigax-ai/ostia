import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  FAKE_MCP_SERVER,
  graphsHarness,
  type Harness,
  MCP_SECRET,
  POLL,
} from '../../test/graphsHarness'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  webContents: { fromId: () => ({ isDestroyed: () => false, send: () => {} }) },
}))

type Line = Record<string, unknown> & { type: string }

const graph = (nodes: string) => `version: 1
on: [{ manual: {} }]
start: a
state:
  task: { type: string, default: "the cart total" }
  answer: { type: string, default: "" }
  err: { type: string, default: "" }
nodes:
${nodes}
edges: []
`

describe('connectors on the built-in graphs extension (real CLI, real socket, fake MCP server)', () => {
  let h: Harness

  const lines = (runId: string, _name: string): Line[] => h.journal(runId) as unknown as Line[]
  const run = async (
    name: string,
    text: string,
  ): Promise<{ runId: string; state: Record<string, unknown> }> => {
    h.writeGraph(name, text)
    const enabled = await h.enable(name)
    if (!enabled.ok) throw new Error(JSON.stringify(enabled))
    const res = await h.panel('runNow', { name })
    if (!res.ok) throw new Error(JSON.stringify(res))
    const runId = (res.data as { runId: string }).runId
    const found = await vi.waitUntil(() => {
      const all = lines(runId, name)
      return all.some((l) => l.type === 'run-end') ? all : undefined
    }, POLL)
    const last = [...found].reverse().find((l) => l.type === 'state') as
      | { state: Record<string, unknown> }
      | undefined
    return { runId, state: last?.state ?? {} }
  }

  beforeAll(async () => {
    h = await graphsHarness({ mcp: true })
  }, 60_000)

  afterAll(() => h.stopAll())

  it('GRF-C64 a connector node calls the MCP echo tool with a templated input and its answer is in the state', async () => {
    const { state } = await run(
      'echo',
      graph(
        '  - { id: a, kind: connector, with: { use: "mcp:fake/echo", input: { text: "{{state.task}}" } }, out: { data.text: answer } }',
      ),
    )
    expect(state.answer).toBe('echo: the cart total')
  })

  it('GRF-C65 a server that is off, a tool that is off and an unknown server fail with the host message, and a catch goes on', async () => {
    const errors: Record<string, string> = {}
    for (const [name, use] of [
      ['off', 'mcp:quiet/echo'],
      ['tooloff', 'mcp:fake/fail'],
      ['nobody', 'mcp:nobody/echo'],
    ] as const) {
      const { state } = await run(
        name,
        graph(
          `  - { id: a, kind: connector, with: { use: "${use}", input: { text: x } }, out: { error.message: err }, catch: [{ errors: [ConnectorFailed], then: continue }] }`,
        ),
      )
      errors[name] = String(state.err)
    }
    expect(errors.off).toContain('This MCP server is not connected.')
    expect(errors.tooloff).toContain('This MCP tool is turned off.')
    expect(errors.nobody).toContain('This MCP server is not connected.')
  })

  it('GRF-C66 ostia graph nodes lists the MCP servers and tools that are on, the native connectors and the connections, and no command, URL or secret', async () => {
    const out = await h.cli(h.human, ['graph', 'nodes'])
    expect(out.code).toBe(0)
    const kinds = JSON.parse(out.stdout) as { kind: string; connectors?: Record<string, unknown> }[]
    const connector = kinds.find((k) => k.kind === 'connector')
    expect(connector?.connectors?.mcp).toEqual([
      { server: 'fake', tools: ['echo', 'env', 'slow', 'exit'] },
    ])
    expect((connector?.connectors?.native as { id: string }[]).map((n) => n.id)).toEqual(['http'])
    expect(out.stdout).not.toContain(FAKE_MCP_SERVER)
    expect(out.stdout).not.toContain(process.execPath)
    expect(out.stdout).not.toContain(MCP_SECRET)
    expect(out.stdout).not.toContain('quiet')
  })

  it('GRF-C101 a call to a server that needs a secret works and the secret is in no graph file, journal, show or log', async () => {
    const { runId, state } = await run(
      'secret',
      graph(
        '  - { id: a, kind: connector, with: { use: "mcp:fake/echo", input: { text: hello } }, out: { data.text: answer } }',
      ),
    )
    expect(state.answer).toBe('echo: hello')
    const show = await h.cli(h.human, ['graph', 'show', runId])
    const files = readdirSync(join(h.workDir, '.ostia/graphs')).map((f) =>
      readFileSync(join(h.workDir, '.ostia/graphs', f), 'utf8'),
    )
    for (const text of [
      JSON.stringify(lines(runId, 'secret')),
      show.stdout,
      h.logs.join('\n'),
      ...files,
    ])
      expect(text).not.toContain(MCP_SECRET)
  })
})
