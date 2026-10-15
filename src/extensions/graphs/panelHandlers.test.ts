import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { settle } from '@aurigax-ai/wire/testing'
import { describe, expect, it } from 'vitest'
import { ok } from '../sdk'
import { type HostHarness, hostHarness } from './fakeExt'
import { panelHandlers } from './panelHandlers'
import type { Definition, ListModel, RunModel } from './panelModel'

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

function panel(files: Record<string, string>) {
  const workDir = mkdtempSync(join(tmpdir(), 'graphs-panel-'))
  mkdirSync(join(workDir, '.ostia/graphs'), { recursive: true })
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(workDir, '.ostia/graphs', `${name}.yaml`), text)
  const h = hostHarness({ workspaceId: 'w1', workDir, kind: 'terminal' })
  const handlers = panelHandlers(
    h.runner,
    { ...h.ext, focusPane: async () => ok() },
    async () => {},
  )
  const call = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const res = await handlers[command]?.({ workspaceId: 'w1', ...args })
    if (!res?.ok) throw new Error(JSON.stringify(res))
    return res.data as T
  }
  return { h, workDir, call }
}

async function startAgentRun(h: HostHarness, call: ReturnType<typeof panel>['call']) {
  const def = await call<Definition>('definition', { name: 'agent' })
  await call('enable', { name: 'agent', fingerprint: def.fingerprint })
  const { runId } = await call<{ runId: string }>('runNow', { name: 'agent' })
  await settle()
  expect(h.panes.map((p) => p.paneId)).toEqual(['pane-1'])
  return runId
}

describe('the Graphs panel data', () => {
  it('GRF-C140 an empty folder lists no graphs and names the folder to put them in', async () => {
    const { workDir, call } = panel({})
    expect(await call<ListModel>('list')).toEqual({
      workspaceId: 'w1',
      folder: join(workDir, '.ostia/graphs'),
      scratch: false,
      graphs: [],
    })
  })

  it('GRF-C140 a graph that does not load is listed invalid with its problem code and node', async () => {
    const { call } = panel({ invalid: INVALID, ready: READY })
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
    const { call } = panel({ [name]: text })
    expect((await call<ListModel>('list')).graphs[0]?.agentsMayStart).toBe(agents)
    const def = await call<Definition>('definition', { name })
    expect(def.agentsMayStart).toBe(agents)
    expect(def.triggers[0]?.kind).toBe('manual')
  })

  it('GRF-C141 the definition shows each node’s fields and the when edge with its condition', async () => {
    const { call } = panel({ ready: READY })
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
    const { h, call } = panel({ agent: AGENT })
    const runId = await startAgentRun(h, call)
    const run = await call<RunModel>('run', { runId })
    expect(run.graph).toBe('agent')
    expect(run.nodes.find((n) => n.node === 'work')).toMatchObject({ pane: 'pane-1' })
  })

  it('GRF-C142 a run shows no pane for an agent node whose pane closed', async () => {
    const { h, call } = panel({ agent: AGENT })
    const runId = await startAgentRun(h, call)
    h.panes.length = 0
    const run = await call<RunModel>('run', { runId })
    expect(run.nodes.find((n) => n.node === 'work')).not.toHaveProperty('pane')
  })
})
