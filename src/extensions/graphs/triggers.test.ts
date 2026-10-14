import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MINUTE_MS } from '@aurigax-ai/graph'
import { settle } from '@aurigax-ai/graph/testing'
import { describe, expect, it } from 'vitest'
import { type HostHarness, hostHarness } from './fakeExt'
import { panelHandlers } from './panelHandlers'
import { TriggerHost } from './triggers'

const head = (on: string) => `version: 1
on: [${on}]
start: a
state: { n: { type: integer, default: 0 } }
`

function workspace(files: Record<string, string>, extra: { sandboxed?: boolean } = {}) {
  const workDir = mkdtempSync(join(tmpdir(), 'graphs-triggers-'))
  mkdirSync(join(workDir, '.ostia/graphs'), { recursive: true })
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(workDir, '.ostia/graphs', `${name}.yaml`), text)
  return { workspaceId: 'w1', workDir, kind: 'terminal', ...extra }
}

function enable(h: HostHarness, name: string): void {
  const listing = h.runner.graph('w1', name)
  if (!listing?.entry.loaded) throw new Error(JSON.stringify(listing?.problems))
  expect(h.runner.enable('w1', name, listing.entry.loaded.fingerprint)).toEqual({ ok: true })
}

function triggerHost(
  h: HostHarness,
  watcher?: ConstructorParameters<typeof TriggerHost>[0]['watcher'],
) {
  const host = new TriggerHost({
    clock: h.clock,
    dataDir: null,
    enabled: () => h.runner.enabledGraphs(),
    fire: (graph, payload) => void h.runner.fire(graph, payload),
    ownPane: (ws, graph, pane) => h.runner.ownPane(ws, graph, pane),
    changed: () => {},
    ...(watcher ? { watcher } : {}),
  })
  host.refresh()
  return host
}

const runsOf = (h: HostHarness, graph: string) => h.runner.runs('w1', graph)

describe('the Ostia host of triggers', () => {
  it('starts an enabled graph on its schedule, and nothing before Enable', async () => {
    const h = hostHarness(
      workspace({
        tick: `${head('{ schedule: { every: 5m } }')}nodes:\n  - { id: a, kind: router }\nedges: []\n`,
      }),
    )
    const host = triggerHost(h)
    await h.clock.advance(6 * MINUTE_MS)
    expect(runsOf(h, 'tick')).toHaveLength(0)
    enable(h, 'tick')
    host.refresh()
    expect(host.needsLiveHost()).toBe(true)
    await h.clock.advance(11 * MINUTE_MS)
    await settle()
    expect(runsOf(h, 'tick')).toHaveLength(2)
    host.stop()
  })

  it('a command or agent event of a pane its own run started never fires the same graph', async () => {
    const h = hostHarness(
      workspace({
        loop: `${head('{ manual: {} }, { agent: { state: stopped } }, { command: { exit: zero } }')}nodes:\n  - { id: a, kind: agent, with: { mode: start, agent: claude, prompt: p } }\nedges: []\n`,
      }),
    )
    enable(h, 'loop')
    const host = triggerHost(h)
    expect(h.runner.start('w1', 'loop', { byAgent: false, inputs: [] })).toMatchObject({ ok: true })
    await settle()
    expect(h.runner.ownPane('w1', 'loop', 'pane-1')).toBe(true)
    await h.stop('pane-1')
    host.agent('w1', 'pane-1', 'stopped', 'claude')
    host.command('w1', 'pane-1', 0)
    await settle()
    expect(runsOf(h, 'loop')).toHaveLength(1)
    host.agent('w1', 'pane-other', 'stopped', 'claude')
    await settle()
    expect(runsOf(h, 'loop')).toHaveLength(2)
    host.stop()
  })

  it('the panes its runs opened still never fire the graph after a restart, ended runs included', async () => {
    const ws = workspace({
      loop: `${head('{ manual: {} }, { agent: { state: stopped } }')}nodes:\n  - { id: a, kind: agent, with: { mode: start, agent: claude, prompt: p } }\nedges: []\n`,
    })
    const h = hostHarness(ws)
    enable(h, 'loop')
    expect(h.runner.start('w1', 'loop', { byAgent: false, inputs: [] })).toMatchObject({ ok: true })
    await settle()
    await h.stop('pane-1')
    expect(runsOf(h, 'loop').map((r) => r.status)).toEqual(['done'])
    const later = hostHarness(ws, h.store)
    expect(later.runner.ownPane('w1', 'loop', 'pane-1')).toBe(true)
    const host = triggerHost(later)
    host.agent('w1', 'pane-1', 'stopped', 'claude')
    await settle()
    expect(runsOf(later, 'loop')).toHaveLength(1)
    host.stop()
  })

  it('GRF-C190 a trigger that fires while a run is still active is skipped, and the panel row says how many', async () => {
    const h = hostHarness(
      workspace({
        busy: `${head('{ manual: {} }, { command: {} }')}nodes:\n  - { id: a, kind: agent, with: { mode: start, agent: claude, prompt: p } }\nedges: []\n`,
      }),
    )
    enable(h, 'busy')
    const host = triggerHost(h)
    expect(h.runner.start('w1', 'busy', { byAgent: false, inputs: [] })).toMatchObject({ ok: true })
    await settle()
    host.command('w1', 'p-other', 0)
    host.command('w1', 'p-other', 1)
    await settle()
    expect(runsOf(h, 'busy')).toHaveLength(1)
    const handlers = panelHandlers(
      h.runner,
      { ...h.ext, focusPane: async () => ({ ok: true }) },
      async () => {},
    )
    const res = (await handlers.list?.({ workspaceId: 'w1' })) as {
      data: { graphs: { name: string; skipped?: number }[] }
    }
    expect(res.data.graphs.find((g) => g.name === 'busy')?.skipped).toBe(2)
    host.stop()
  })

  it('an agent that is waiting fires a state: waiting trigger with the pane in trigger.pane', async () => {
    const h = hostHarness(
      workspace({
        nudge: `${head('{ agent: { state: waiting, agent: codex } }')}nodes:\n  - { id: a, kind: router }\nedges: []\n`,
      }),
    )
    enable(h, 'nudge')
    const host = triggerHost(h)
    host.agent('w1', 'p9', 'waiting', 'claude')
    host.agent('w1', 'p9', 'waiting', 'codex')
    await settle()
    const runs = runsOf(h, 'nudge')
    expect(runs).toHaveLength(1)
    expect(h.runner.engine.run(runs[0]?.runId ?? '')?.state.trigger).toMatchObject({
      pane: 'p9',
      state: 'waiting',
    })
    host.stop()
  })

  it('collects changes of a second into one run with trigger.paths, and reports a refused watcher', async () => {
    const files = `${head('{ files: { glob: "src/**/*.ts" } }, { command: {} }')}nodes:\n  - { id: a, kind: router }\nedges: []\n`
    const h = hostHarness(workspace({ files }))
    enable(h, 'files')
    let report: (rel: string) => void = () => {}
    const host = triggerHost(h, (_root, onPath) => {
      report = onPath
      return { start: () => ({ ok: true, folders: 1 }), stop: () => {} }
    })
    report('src/a/b.ts')
    report('src/a/b.ts')
    report('README.md')
    await h.clock.advance(1000)
    await settle()
    const runs = runsOf(h, 'files')
    expect(runs).toHaveLength(1)
    expect(h.runner.engine.run(runs[0]?.runId ?? '')?.state.trigger).toEqual({
      kind: 'files',
      paths: ['src/a/b.ts'],
    })
    host.stop()

    const refused = hostHarness(workspace({ files }))
    enable(refused, 'files')
    const off = triggerHost(refused, () => ({
      start: () => ({ ok: false, reason: 'too-many-folders' }),
      stop: () => {},
    }))
    expect(off.filesRefused('w1')).toBe(true)
    off.command('w1', 'p1', 0)
    await settle()
    expect(runsOf(refused, 'files')).toHaveLength(1)
    off.stop()
  })
})
