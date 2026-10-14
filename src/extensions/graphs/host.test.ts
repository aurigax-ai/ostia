import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { contractFailures } from '../../../graph-engine/src/engine/contractSuite'
import { settle } from '../../../graph-engine/src/engine/fakeHost'
import { RATE_RETRY_MS } from './agentNode'
import { type HostHarness, fakeExt, hostHarness } from './fakeExt'
import { GraphsRunner } from './runner'

function workspace(files: Record<string, string>) {
  const workDir = mkdtempSync(join(tmpdir(), 'graphs-host-'))
  mkdirSync(join(workDir, '.ostia/graphs'), { recursive: true })
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(workDir, '.ostia/graphs', `${name}.yaml`), text)
  return { workspaceId: 'w1', workDir, kind: 'terminal' }
}

function enableAndStart(
  h: HostHarness,
  name: string,
  inputs: string[] = [],
  pane?: string,
): string {
  const listing = h.runner.graph('w1', name)
  if (!listing?.entry.loaded) throw new Error(JSON.stringify(listing?.problems))
  expect(h.runner.enable('w1', name, listing.entry.loaded.fingerprint)).toEqual({ ok: true })
  const res = h.runner.start('w1', name, { byAgent: false, inputs, ...(pane ? { pane } : {}) })
  if (!res.ok || !('runId' in res)) throw new Error(JSON.stringify(res))
  return res.runId
}

const head = (state = 'n: { type: integer, default: 0 }') => `version: 1
on: [{ manual: { agents: true } }]
start: a
state: { ${state} }
`

describe('the Ostia host', () => {
  it('GRF-C6 passes the engine’s host contract suite with fakes for ext', async () => {
    const fake = fakeExt()
    fake.execReply = () => ({
      ok: true,
      exitCode: 3,
      stdout: '',
      stderr: '',
      timedOut: false,
      truncated: false,
      sandboxed: false,
    })
    const runner = new GraphsRunner({
      ext: fake.ext,
      dataDir: null,
      clock: (await import('../../../graph-engine/src/cli/headlessHost')).realClock,
      changed: () => {},
    })
    const failures = await contractFailures({
      host: runner.host,
      notices: fake.notices,
      command: ['true'],
      expectedExit: 3,
    })
    expect(failures).toEqual([])
    expect(fake.execs[0]).toMatchObject({ workspaceId: 'probe', command: ['true'] })
  })

  it('GRF-C52 an agent node opens a background terminal and its prompt ends with the report paragraph', async () => {
    const h = hostHarness(
      workspace({
        g: `${head('v: { type: string, default: "" }')}nodes:
  - { id: a, kind: agent, with: { mode: start, agent: claude, prompt: "Do the task." }, result: { type: object, properties: { v: { type: string } }, required: [v] }, out: { result.v: v } }
edges: []
`,
      }),
    )
    const id = enableAndStart(h, 'g')
    await settle()
    expect(h.runAgent[0]).toMatchObject({ workspaceId: 'w1', agent: 'claude', background: true })
    expect(String(h.runAgent[0].prompt)).toMatch(
      /^Do the task\.\n\nWhen you have finished, report your result/,
    )
    expect(String(h.runAgent[0].prompt)).toContain("ostia graph report --json '<one JSON object>'")
    expect(await h.runner.report('pane-1', { v: 'ok' })).toEqual({ ok: true })
    await h.stop('pane-1')
    const run = h.runner.engine.run(id)?.state
    expect(run?.state.v).toBe('ok')
    expect(run?.history.get('a')?.output).toMatchObject({ outcome: 'stopped', result: { v: 'ok' } })
  })

  it('GRF-C96 a message to a pane that moved away or closed sends nothing and ends closed', async () => {
    const h = hostHarness(
      workspace({
        g: `${head('o: { type: string, default: "" }')}nodes:
  - { id: a, kind: agent, with: { mode: message, to: trigger, prompt: "go on", wait: none }, out: { outcome: o } }
edges: []
`,
      }),
    )
    h.panes.push({
      paneId: 'moved',
      workspaceId: 'w2',
      kind: 'terminal',
      title: 't',
      running: true,
      blockCount: 0,
    })
    const moved = enableAndStart(h, 'g', [], 'moved')
    await settle()
    expect(h.busSent).toEqual([])
    expect(h.runner.engine.run(moved)?.state.state.o).toBe('closed')
  })

  it('GRF-C99 an agent node that meets core’s rate limit waits for the next minute and starts then', async () => {
    const h = hostHarness(
      workspace({
        g: `${head()}nodes:
  - { id: a, kind: agent, with: { mode: start, agent: claude, prompt: p } }
edges: []
`,
      }),
    )
    let refusals = 1
    h.refuseAgent = () =>
      refusals-- > 0
        ? { ok: false, error: 'rate-limited', message: 'too many agent tasks this minute' }
        : null
    enableAndStart(h, 'g')
    await settle()
    expect(h.runAgent).toHaveLength(1)
    expect(h.panes).toHaveLength(0)
    await h.clock.advance(RATE_RETRY_MS)
    expect(h.runAgent).toHaveLength(2)
    expect(h.panes).toHaveLength(1)
  })

  it('GRF-C166 a continue with no session or a missing folder raises AgentGone and opens nothing', async () => {
    const text = `${head('e: { type: object, default: {} }')}nodes:
  - { id: impl, kind: agent, with: { mode: start, agent: claude, prompt: p, wait: none } }
  - { id: more, kind: agent, with: { mode: continue, from: impl, prompt: again }, out: { error: e }, catch: [{ errors: [AgentGone], then: continue }] }
edges:
  - { from: impl, to: more }
`.replace('start: a', 'start: impl')
    for (const [error, message] of [
      ['no-session', 'that pane has no agent session to continue'],
      ['resume-folder-missing', '/gone no longer exists'],
    ]) {
      const h = hostHarness(workspace({ g: text }))
      h.refuseAgent = (opts) => (opts.continueFrom ? { ok: false, error, message } : null)
      const id = enableAndStart(h, 'g')
      await settle()
      const e = h.runner.engine.run(id)?.state.state.e as { name?: string; message?: string }
      expect(e).toMatchObject({ name: 'AgentGone' })
      expect(e.message).toContain(error)
      expect(h.runAgent.map((o) => o.continueFrom)).toEqual([undefined, 'pane-1'])
      expect(h.panes).toHaveLength(1)
    }
  })

  it('GRF-C73 an agent whose pane closed while Ostia was away is lost and, being once, interrupts the run', async () => {
    const text = `${head()}nodes:
  - { id: a, kind: agent, with: { mode: start, agent: claude, prompt: p } }
edges: []
`
    const ws = workspace({ g: text })
    const h = hostHarness(ws)
    const id = enableAndStart(h, 'g')
    await settle()
    const later = hostHarness(ws, h.store)
    await settle()
    const run = later.runner.engine.run(id)
    expect(run?.state.status).toBe('interrupted')
    expect(later.runAgent).toEqual([])
  })

  it('GRF-C163 an agent that stops without a report raises NoResult 30 seconds later', async () => {
    const h = hostHarness(
      workspace({
        g: `${head('v: { type: string, default: "" }')}nodes:
  - { id: a, kind: agent, with: { mode: start, agent: claude, prompt: p }, result: { type: object, properties: { v: { type: string } }, required: [v] }, out: { result.v: v } }
edges: []
`,
      }),
    )
    const id = enableAndStart(h, 'g')
    await settle()
    await h.stop('pane-1')
    expect(h.runner.engine.run(id)?.state.status).toBe('running')
    await h.clock.advance(29_000)
    expect(h.runner.engine.run(id)?.state.status).toBe('running')
    await h.clock.advance(1_000)
    expect(h.runner.engine.run(id)?.state.failure).toMatchObject({ node: 'a', name: 'NoResult' })
  })

  it('GRF-C168 Continue session on an interrupted agent node continues its session with the fixed prompt and waits for its report', async () => {
    const text = `${head('v: { type: string, default: "" }')}nodes:
  - { id: a, kind: agent, with: { mode: start, agent: claude, prompt: p }, result: { type: object, properties: { v: { type: string } }, required: [v] }, out: { result.v: v } }
edges: []
`
    const ws = workspace({ g: text })
    const h = hostHarness(ws)
    const id = enableAndStart(h, 'g')
    await settle()
    const later = hostHarness(ws, h.store)
    await settle()
    const run = later.runner.engine.run(id)
    expect(run?.state.status).toBe('interrupted')
    expect(await later.runner.control('w1', id, 'continue', 'a')).toEqual({ ok: true })
    await settle()
    expect(later.runAgent[0]).toMatchObject({ continueFrom: 'pane-1', background: true })
    expect(String(later.runAgent[0].prompt)).toMatch(
      /^You were interrupted\. Finish the task and report\.\n\nWhen you have finished, report/,
    )
    expect(run?.state.active.get('a')?.phase).toBe('waiting')
    expect(await later.runner.report('pane-1', { v: 'resumed' })).toEqual({ ok: true })
    await later.stop('pane-1')
    expect(run?.state.state.v).toBe('resumed')
  })

  it('GRF-C93 a command node whose sandbox cannot start raises SandboxUnavailable', async () => {
    const h = hostHarness(
      workspace({
        g: `${head('e: { type: object, default: {} }')}nodes:
  - { id: a, kind: command, with: { run: [make] }, out: { error: e }, catch: [{ errors: [SandboxUnavailable], then: continue }] }
edges: []
`,
      }),
    )
    h.execReply = () => ({
      ok: false,
      error: 'sandbox-unavailable',
      message: 'bwrap is not installed',
    })
    const id = enableAndStart(h, 'g')
    await settle()
    expect(h.runner.engine.run(id)?.state.state.e).toMatchObject({ name: 'SandboxUnavailable' })
  })

  it('a report reaches the run it names, and one that names none is refused while two runs wait on the pane', async () => {
    const text = (name: string) => `${head('v: { type: string, default: "" }')}nodes:
  - { id: a, kind: agent, with: { mode: message, to: trigger, prompt: "${name}" }, result: { type: object, properties: { v: { type: string } }, required: [v] }, out: { result.v: v } }
edges: []
`
    const h = hostHarness(workspace({ one: text('one'), two: text('two') }))
    h.panes.push({
      paneId: 'starter',
      workspaceId: 'w1',
      kind: 'terminal',
      title: 'claude',
      running: true,
      blockCount: 0,
      agent: 'claude',
    })
    const first = enableAndStart(h, 'one', [], 'starter')
    const second = enableAndStart(h, 'two', [], 'starter')
    await settle()
    expect(h.busSent.map((m) => m.text.split('\n')[0])).toEqual(['one', 'two'])
    expect(h.busSent[0]?.text).toContain(`--run ${first}`)
    expect(await h.runner.report('starter', { v: 'x' })).toMatchObject({
      ok: false,
      error: 'ambiguous',
    })
    expect(await h.runner.report('starter', { v: 'for one' }, first)).toEqual({ ok: true })
    expect(await h.runner.report('starter', { v: 'for two' }, second)).toEqual({ ok: true })
    await h.stop('starter')
    expect(h.runner.engine.run(first)?.state.state.v).toBe('for one')
    expect(h.runner.engine.run(second)?.state.state.v).toBe('for two')
  })
})
