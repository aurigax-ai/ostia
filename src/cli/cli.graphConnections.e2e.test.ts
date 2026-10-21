import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { graphsHarness, type Harness, POLL } from '../../test/graphsHarness'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  webContents: { fromId: () => ({ isDestroyed: () => false, send: () => {} }) },
}))

type Line = Record<string, unknown> & { type: string }

const LINE_SECRET = ['sk', 'line', 'L'.repeat(24)].join('_')
const USER_SECRET = ['pw', 'user', 'U'.repeat(24)].join('_')

describe('connection secrets on the built-in graphs extension (real CLI, real socket)', () => {
  let h: Harness
  let server: Server
  let base: string
  let hits = 0

  const lines = (runId: string, _name: string): Line[] => h.journal(runId) as unknown as Line[]

  beforeAll(async () => {
    server = createServer((_req, res) => {
      hits++
      res.end('{}')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    h = await graphsHarness({ connections: true })
  }, 60_000)

  afterAll(async () => {
    h.stopAll()
    await new Promise((r) => server.close(r))
  })

  it('a secret with a line break and a base URL with user:pass@ reach no journal, panel model, ostia graph show or log', async () => {
    expect(
      h.host.config.saveConnection('graphs', {
        name: 'linebreak',
        kind: 'http',
        fields: { baseUrl: base, auth: 'bearer' },
        secrets: { secret: `${LINE_SECRET}\r\nX-Evil: 1` },
      }),
    ).toMatchObject({ ok: false })
    expect(
      h.host.config.saveConnection('graphs', {
        name: 'linebreak',
        kind: 'http',
        fields: { baseUrl: base, auth: 'bearer' },
        secrets: { secret: 'placeholder' },
      }),
    ).toMatchObject({ ok: true })
    h.secrets.set('graphs', '@connection/linebreak/secret', `${LINE_SECRET}\r\nX-Evil: 1`)
    const withUser = base.replace('http://', `http://someone:${USER_SECRET}@`)
    expect(
      h.host.config.saveConnection('graphs', {
        name: 'userinfo',
        kind: 'http',
        fields: { baseUrl: withUser, auth: 'none' },
      }),
    ).toMatchObject({ ok: true })
    for (const name of ['linebreak', 'userinfo']) {
      h.writeGraph(
        name,
        `version: 1
on: [{ manual: {} }]
start: a
state: { err: { type: string, default: "" } }
nodes:
  - { id: a, kind: connector, with: { use: "http.request", connection: ${name}, input: { path: "/x" } }, out: { error.message: err }, catch: [{ errors: [ConnectorFailed], then: continue }] }
edges: []
`,
      )
      const enabled = await h.enable(name)
      expect(enabled.ok, JSON.stringify(enabled)).toBe(true)
      const res = await h.panel('runNow', { name })
      expect(res.ok, JSON.stringify(res)).toBe(true)
      const runId = (res.data as { runId: string }).runId
      await vi.waitUntil(() => lines(runId, name).some((l) => l.type === 'run-end'), POLL)
      const view = await h.panel('run', { runId })
      const show = await h.cli(h.human, ['graph', 'show', runId])
      const texts = [
        JSON.stringify(lines(runId, name)),
        JSON.stringify(view),
        show.stdout,
        show.stderr,
      ]
      for (const text of [...texts, h.logs.join('\n')]) {
        expect(text).not.toContain(LINE_SECRET)
        expect(text).not.toContain(USER_SECRET)
      }
      expect(JSON.stringify(lines(runId, name))).toContain('ConnectorFailed')
    }
    expect(hits).toBe(0)
  })
})
