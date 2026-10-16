import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ok } from '@aurigax-ai/ostia-extension-sdk'
import { cliClient } from '@aurigax-ai/wire/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type HarnessOptions,
  type HostHarness,
  closeHarnesses,
  fakeExt,
  hostHarness,
  settle,
} from './fakeExt'
import en from './locales/en.json'
import { panelHandlers } from './panelHandlers'
import type { Definition, ListModel, RunModel, RuntimeModel } from './panelModel'
import type { Workspace } from './runner'

const READY = `version: 1
description: Ask, then start an agent
on: [{ manual: { agents: true } }]
start: build
state:
  exit: { type: integer, default: -1 }
  task: { type: string, default: "the cart total" }
nodes:
  - { id: build, kind: command, with: { run: [sh, -c, "exit 0"] }, out: { exit: exit } }
  - { id: ask, kind: approval, with: { question: "Start the agent on {{state.task}}?" } }
  - { id: work, kind: agent, with: { mode: start, agent: claude, prompt: "Fix {{state.task}}" } }
edges:
  - from: build
    when: [{ if: "state.exit == 0", to: ask }]
    else: end
  - { from: ask, to: work }
`

const HUMAN_ONLY = `version: 1
on: [{ manual: {} }]
start: a
state: { n: { type: integer, default: 0 } }
nodes:
  - { id: a, kind: notify, with: { title: "before" } }
edges: []
`

const INVALID = `version: 1
on: [{ manual: {} }]
start: a
state: { n: { type: integer, default: 0 } }
nodes:
  - { id: a, kind: nope }
edges: []
`

const AGENT = `version: 1
on: [{ manual: {} }]
start: work
state: { n: { type: integer, default: 0 } }
nodes:
  - { id: work, kind: agent, with: { mode: start, agent: claude, prompt: "Fix it" } }
edges: []
`

afterEach(async () => {
  vi.unstubAllEnvs()
  await closeHarnesses()
})

async function panel(
  files: Record<string, string>,
  opts: { harness?: HarnessOptions; others?: Workspace[] } = {},
) {
  const workDir = mkdtempSync(join(tmpdir(), 'graphs-panel-'))
  mkdirSync(join(workDir, '.ostia/graphs'), { recursive: true })
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(workDir, '.ostia/graphs', `${name}.yaml`), text)
  const w1: Workspace = { workspaceId: 'w1', workDir, kind: 'terminal' }
  const h = await hostHarness(w1, undefined, fakeExt(), opts.harness)
  const others = opts.others
  const handlers = panelHandlers(
    h.runner,
    { ...h.ext, focusPane: async () => ok() },
    others ? () => h.runner.setWorkspaces([w1, ...others]) : async () => {},
  )
  const call = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const res = await handlers[command]?.({ workspaceId: 'w1', ...args })
    if (!res?.ok) throw new Error(JSON.stringify(res))
    return res.data as T
  }
  return { h, workDir, call }
}

async function startAgentRun(h: HostHarness, call: Awaited<ReturnType<typeof panel>>['call']) {
  const def = await call<Definition>('definition', { name: 'agent' })
  await call('enable', { name: 'agent', fingerprint: def.fingerprint })
  const { runId } = await call<{ runId: string }>('runNow', { name: 'agent' })
  await settle()
  expect(h.panes.map((p) => p.paneId)).toEqual(['pane-1'])
  return runId
}

describe('the Graphs panel data', () => {
  it('GRF-C140 an empty folder lists no graphs and names the folder to put them in', async () => {
    const { workDir, call } = await panel({})
    expect(await call<ListModel>('list')).toEqual({
      workspaceId: 'w1',
      folder: join(workDir, '.ostia/graphs'),
      scratch: false,
      graphs: [],
    })
  })

  it('GRF-C140 a graph that does not load is listed invalid with its problem code and node', async () => {
    const { call } = await panel({ invalid: INVALID, ready: READY })
    const rows = (await call<ListModel>('list')).graphs
    expect(rows.map((r) => [r.name, r.state])).toEqual([
      ['invalid', 'invalid'],
      ['ready', 'not-enabled'],
    ])
    expect(rows[0]?.problem).toMatchObject({ code: 'unknown-kind', node: 'a' })
    expect(rows[1]?.problem).toBeUndefined()
  })

  it.each([
    ['ready', READY, true],
    ['human', HUMAN_ONLY, false],
  ])('GRF-C141 the %s graph says whether agents may start it', async (name, text, agents) => {
    const { call } = await panel({ [name]: text })
    expect((await call<ListModel>('list')).graphs[0]?.agentsMayStart).toBe(agents)
    const def = await call<Definition>('definition', { name })
    expect(def.agentsMayStart).toBe(agents)
    expect(def.triggers[0]?.kind).toBe('manual')
  })

  it('GRF-C141 the definition shows each node’s fields and the when edge with its condition', async () => {
    const { call } = await panel({ ready: READY })
    const def = await call<Definition>('definition', { name: 'ready' })
    expect(def.start).toEqual(['build'])
    expect(def.nodes.find((n) => n.id === 'build')?.fields).toEqual({
      run: ['sh', '-c', 'exit 0'],
    })
    expect(def.nodes.find((n) => n.id === 'ask')?.fields).toEqual({
      question: 'Start the agent on {{state.task}}?',
    })
    expect(def.nodes.find((n) => n.id === 'work')?.fields).toMatchObject({
      prompt: 'Fix {{state.task}}',
    })
    expect(def.edges).toEqual([
      { from: 'build', to: 'ask', condition: 'state.exit == 0', kind: 'when' },
      { from: 'build', to: 'end', kind: 'else' },
      { from: 'ask', to: 'work', kind: 'plain' },
    ])
  })

  it('GRF-C142 a run shows the agent node’s pane while that pane is open', async () => {
    const { h, call } = await panel({ agent: AGENT })
    const runId = await startAgentRun(h, call)
    const run = await call<RunModel>('run', { runId })
    expect(run.graph).toBe('agent')
    expect(run.nodes.find((n) => n.node === 'work')).toMatchObject({ pane: 'pane-1' })
  })

  it('GRF-C142 a run shows no pane for an agent node whose pane closed', async () => {
    const { h, call } = await panel({ agent: AGENT })
    const runId = await startAgentRun(h, call)
    h.panes.length = 0
    const run = await call<RunModel>('run', { runId })
    expect(run.nodes.find((n) => n.node === 'work')).not.toHaveProperty('pane')
  })

  it('GRF-C208 the panel registers each open non-scratch workspace as a scope and lists, enables, runs and pauses through the runtime', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'graphs-scratch-'))
    const { h, workDir, call } = await panel(
      { agent: AGENT },
      { others: [{ workspaceId: 'w2', workDir: scratch, kind: 'scratch' }] },
    )
    const list = await call<ListModel>('list')
    const scopes = readFileSync(join(h.runtime.paths.data, 'scopes.json'), 'utf8')
    expect(scopes).toContain(realpathSync(workDir))
    expect(scopes).not.toContain(realpathSync(scratch))
    expect(list.graphs.map((g) => [g.name, g.state])).toEqual([['agent', 'not-enabled']])
    const def = await call<Definition>('definition', { name: 'agent' })
    await call('enable', { name: 'agent', fingerprint: def.fingerprint })
    expect((await call<ListModel>('list')).graphs.map((g) => g.state)).toEqual(['enabled'])
    const { runId } = await call<{ runId: string }>('runNow', { name: 'agent' })
    await settle()
    expect(h.journal(runId).map((e) => e.type)).toContain('run-start')
    await call('control', { runId, action: 'pause' })
    await settle()
    expect((await call<RunModel>('run', { runId })).summary.status).toBe('paused')
  })

  it('GRF-C215 graphs enabled and runs kept by the in-extension host show as not enabled and no runs, and Enable is fresh', async () => {
    const old = mkdtempSync(join(tmpdir(), 'graphs-old-data-'))
    vi.stubEnv('OSTIA_EXTENSION_DATA', old)
    const { h, workDir, call } = await panel({ agent: AGENT })
    const def = await call<Definition>('definition', { name: 'agent' })
    writeFileSync(
      join(old, 'enabled.json'),
      JSON.stringify({
        enabled: [
          {
            workspaceId: 'w1',
            realPath: realpathSync(workDir),
            fingerprint: def.fingerprint,
            at: 1,
          },
        ],
        changed: [],
      }),
    )
    mkdirSync(join(old, 'runs', 'old-run'), { recursive: true })
    writeFileSync(
      join(old, 'runs', 'old-run', 'journal.jsonl'),
      `${JSON.stringify({ type: 'run-start', graph: 'agent', runId: 'old-run' })}\n`,
    )
    const fresh = await h.reopen()
    const handlers = panelHandlers(
      fresh.runner,
      { ...fresh.ext, focusPane: async () => ok() },
      async () => {},
    )
    const again = async <T>(command: string, args: Record<string, unknown> = {}) => {
      const res = await handlers[command]?.({ workspaceId: 'w1', ...args })
      if (!res?.ok) throw new Error(JSON.stringify(res))
      return res.data as T
    }
    expect((await again<ListModel>('list')).graphs.map((g) => g.state)).toEqual(['not-enabled'])
    expect(await again<unknown[]>('runs')).toEqual([])
    await again('enable', { name: 'agent', fingerprint: def.fingerprint })
    expect((await again<ListModel>('list')).graphs.map((g) => g.state)).toEqual(['enabled'])
  })

  it('GRF-C223 the note says a daemon runs graphs also while Ostia is closed, and the default runtime while a client is open', async () => {
    const daemon = await panel({}, { harness: { daemon: true } })
    expect(await daemon.call<RuntimeModel>('runtime')).toMatchObject({
      state: 'ready',
      daemon: true,
    })
    const client = await panel({})
    expect(await client.call<RuntimeModel>('runtime')).toMatchObject({
      state: 'ready',
      daemon: false,
    })
    expect(en.messages.runsAsDaemon).toContain('also while Ostia is closed')
    expect(en.messages.runsWhileOpen).toContain('while Ostia is open')
  })

  it('listing again with no graph file changed reloads nothing, so the panel is not told to render again', async () => {
    const { h, call } = await panel({ agent: AGENT, ready: READY }, { others: [] })
    await call<ListModel>('list')
    await settle()
    const watcher = await cliClient(h.runtime.paths)
    const changed: unknown[] = []
    watcher.on('graph.changed', (params) => changed.push(params))
    try {
      for (let i = 0; i < 3; i++) await call<ListModel>('list')
      await settle()
      expect(changed).toEqual([])
    } finally {
      watcher.close()
    }
  })
})
