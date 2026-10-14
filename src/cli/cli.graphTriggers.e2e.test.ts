import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type Harness, graphsHarness, until } from '../../test/graphsHarness'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  webContents: { fromId: () => ({ isDestroyed: () => false, send: () => {} }) },
}))

type Line = Record<string, unknown> & { type: string }

describe('triggers on the built-in graphs extension (real CLI, real socket, real folder watch)', () => {
  let h: Harness

  const runIds = (name: string): string[] => {
    const folder = join(h.dataDir, 'graphs', 'runs', 'w1', name)
    return existsSync(folder) ? readdirSync(folder).sort() : []
  }
  const lines = (name: string, runId: string): Line[] =>
    readFileSync(join(h.dataDir, 'graphs', 'runs', 'w1', name, runId, 'journal.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Line)
  const triggerOf = (name: string, runId: string) =>
    lines(name, runId).find((l) => l.type === 'run-start')?.trigger
  const enable = async (name: string, text: string): Promise<void> => {
    h.writeGraph(name, text)
    const res = await h.enable(name)
    if (!res.ok) throw new Error(JSON.stringify(res))
  }
  const settleFor = (ms: number) => new Promise((r) => setTimeout(r, ms))

  beforeAll(async () => {
    h = await graphsHarness()
  }, 60_000)

  afterAll(() => h.stopAll())

  it('GRF-C48 two writes of src/a/b.ts within a second and one of README.md start one run with trigger.paths', async () => {
    for (const d of ['src/a', 'node_modules/pkg', 'dist'])
      mkdirSync(join(h.workDir, d), { recursive: true })
    writeFileSync(join(h.workDir, '.gitignore'), 'dist/\n')
    await enable(
      'onsave',
      `version: 1
on: [{ files: { glob: "src/**/*.ts" } }, { files: { glob: "**/*.js" } }]
start: a
state: { n: { type: integer, default: 0 } }
nodes:
  - { id: a, kind: router }
edges: []
`,
    )
    await settleFor(500)
    writeFileSync(join(h.workDir, 'node_modules/pkg/index.js'), '1')
    writeFileSync(join(h.workDir, 'dist/out.js'), '1')
    await settleFor(1500)
    expect(runIds('onsave')).toEqual([])
    writeFileSync(join(h.workDir, 'src/a/b.ts'), '1')
    await settleFor(200)
    writeFileSync(join(h.workDir, 'src/a/b.ts'), '2')
    writeFileSync(join(h.workDir, 'README.md'), 'r')
    const [runId] = await until(() => (runIds('onsave').length > 0 ? runIds('onsave') : undefined))
    await settleFor(1500)
    expect(runIds('onsave')).toHaveLength(1)
    expect(triggerOf('onsave', runId as string)).toEqual({ kind: 'files', paths: ['src/a/b.ts'] })
    expect((await h.panel('disable', { name: 'onsave' })).ok).toBe(true)
  }, 60_000)

  it('GRF-C50 the stop of the agent its run started ends the node and starts nothing; another agent stopping starts a run, and a pane running no agent never does', async () => {
    await enable(
      'restart',
      `version: 1
on: [{ manual: {} }, { agent: { state: stopped } }]
start: a
state: { n: { type: integer, default: 0 } }
nodes:
  - { id: a, kind: agent, with: { mode: start, agent: claude, prompt: "Fix the total" } }
edges: []
`,
    )
    const started = await h.panel('runNow', { name: 'restart' })
    expect(started.ok).toBe(true)
    const runId = (started.data as { runId: string }).runId
    const pane = await until(() => h.opened[h.opened.length - 1])
    expect((await h.stop(pane, {})).code).toBe(0)
    await until(() =>
      lines('restart', runId).some((l) => l.type === 'run-end') ? true : undefined,
    )
    await settleFor(500)
    expect(runIds('restart')).toEqual([runId])
    expect((await h.stop(h.remotePane, {})).code).toBe(0)
    await settleFor(500)
    expect(runIds('restart')).toEqual([runId])
    h.human.agent = 'claude'
    expect((await h.stop(h.human, {})).code).toBe(0)
    await until(() => (runIds('restart').length === 2 ? true : undefined))
    const second = runIds('restart').find((id) => id !== runId) as string
    expect(triggerOf('restart', second)).toMatchObject({
      kind: 'agent',
      state: 'stopped',
      pane: h.human.externalId,
    })
    expect((await h.panel('disable', { name: 'restart' })).ok).toBe(true)
  }, 60_000)

  it('GRF-C188 a folder with more than 5000 folders to watch refuses the files trigger, says so, and the other triggers still fire', async () => {
    for (let i = 0; i < 5001; i++)
      mkdirSync(join(h.workDir, 'many', String(i)), { recursive: true })
    await enable(
      'huge',
      `version: 1
on: [{ files: { glob: "**/*.ts" } }, { command: { exit: zero } }]
start: a
state: { n: { type: integer, default: 0 } }
nodes:
  - { id: a, kind: router }
edges: []
`,
    )
    const listed = await until(async () => {
      const res = await h.panel('list')
      const row = (res.data as { graphs: { name: string; filesRefused?: boolean }[] }).graphs.find(
        (g) => g.name === 'huge',
      )
      return row?.filesRefused ? row : undefined
    })
    expect(listed.filesRefused).toBe(true)
    writeFileSync(join(h.workDir, 'src/a/c.ts'), '1')
    await settleFor(1500)
    expect(runIds('huge')).toEqual([])
    h.host.emitEvent('command.finished', {
      paneId: h.human.externalId,
      workspaceId: 'w1',
      exitCode: 0,
      remote: true,
    })
    await settleFor(500)
    expect(runIds('huge')).toEqual([])
    h.host.emitEvent('command.finished', {
      paneId: h.human.externalId,
      workspaceId: 'w1',
      exitCode: 0,
    })
    await until(() => (runIds('huge').length === 1 ? true : undefined))
    expect(triggerOf('huge', runIds('huge')[0] as string)).toMatchObject({
      kind: 'command',
      exit: 0,
    })
  }, 90_000)
})
