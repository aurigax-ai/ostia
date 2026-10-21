import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contractFailures } from '@aurigax-ai/wire/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { RATE_RETRY_MS } from './agentNode'
import { closeHarnesses, fakeExt, type HostHarness, hostHarness, settle } from './fakeExt'
import { GraphsRunner } from './runner'

afterEach(() => closeHarnesses())

function workspace(files: Record<string, string>) {
  const workDir = mkdtempSync(join(tmpdir(), 'graphs-host-'))
  mkdirSync(join(workDir, '.ostia/graphs'), { recursive: true })
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(workDir, '.ostia/graphs', `${name}.yaml`), text)
  return { workspaceId: 'w1', workDir, kind: 'terminal' }
}

async function enableAndStart(
  h: HostHarness,
  name: string,
  inputs: string[] = [],
  pane?: string,
): Promise<string> {
  const listing = await h.runner.graph('w1', name)
  if (!listing?.entry.loaded) throw new Error(JSON.stringify(listing?.problems))
  expect(await h.runner.enable('w1', name, listing.entry.loaded.fingerprint)).toEqual({ ok: true })
  const res = await h.runner.start('w1', name, {
    byAgent: false,
    inputs,
    ...(pane ? { pane } : {}),
  })
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
      clock: (await import('@aurigax-ai/wire')).realClock,
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
    const h = await hostHarness(
      workspace({
        g: `${head('v: { type: string, default: "" }')}nodes:
  - { id: a, kind: agent, with: { mode: start, agent: claude, prompt: "Do the task." }, result: { type: object, properties: { v: { type: string } }, required: [v] }, out: { result.v: v } }
edges: []
`,
      }),
    )
    const id = await enableAndStart(h, 'g')
    await settle()
    expect(h.runAgent[0]).toMatchObject({ workspaceId: 'w1', agent: 'claude', background: true })
    expect(String(h.runAgent[0].prompt)).toMatch(
      /^Do the task\.\n\nWhen you have finished, report your result/,
    )
    expect(String(h.runAgent[0].prompt)).toContain("ostia graph report --json '<one JSON object>'")
    expect(await h.runner.report('pane-1', { v: 'ok' })).toEqual({ ok: true })
    await h.stop('pane-1')
    const run = await h.run(id)
    expect(run?.state.v).toBe('ok')
    expect(run?.view.nodes.find((n) => n.node === 'a')?.output).toMatchObject({
      outcome: 'stopped',
      result: { v: 'ok' },
    })
  })

  it('GRF-C96 a message to a pane that moved away or closed sends nothing and ends closed', async () => {
    const h = await hostHarness(
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
    const moved = await enableAndStart(h, 'g', [], 'moved')
    await settle()
    expect(h.busSent).toEqual([])
    expect((await h.run(moved))?.state.o).toBe('closed')
  })

  it('a message node passes on the bus state and why it is still queued', async () => {
    const h = await hostHarness(
      workspace({
        g: `${head()}nodes:
  - { id: a, kind: agent, with: { mode: message, to: trigger, prompt: "go on", wait: none } }
edges: []
`,
      }),
    )
    h.panes.push({
      paneId: 'p1',
      workspaceId: 'w1',
      kind: 'terminal',
      title: 't',
      running: true,
      blockCount: 0,
    })
    const output = async () => {
      const id = await enableAndStart(h, 'g', [], 'p1')
      await settle()
      return (await h.run(id))?.view.nodes.find((n) => n.node === 'a')?.output
    }
    expect(await output()).toEqual({ pane: 'p1', delivered: 'delivered' })
    h.busReply = () => ({ ok: true, id: 'm2', state: 'queued', pending: 'working' })
    expect(await output()).toEqual({ pane: 'p1', delivered: 'queued', pending: 'working' })
  })

  it('GRF-C99 an agent node that meets core’s rate limit waits for the next minute and starts then', async () => {
    const h = await hostHarness(
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
    await enableAndStart(h, 'g')
    await settle()
    expect(h.runAgent).toHaveLength(1)
    expect(h.panes).toHaveLength(0)
    await h.clock.advance(RATE_RETRY_MS)
    await settle()
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
      const h = await hostHarness(workspace({ g: text }))
      h.refuseAgent = (opts) => (opts.continueFrom ? { ok: false, error, message } : null)
      const id = await enableAndStart(h, 'g')
      await settle()
      const e = (await h.run(id))?.state.e as { name?: string; message?: string }
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
    const h = await hostHarness(workspace({ g: text }))
    const id = await enableAndStart(h, 'g')
    await settle()
    const later = await h.reopen()
    await later.clock.advance(6000)
    await settle()
    expect((await later.run(id))?.status).toBe('interrupted')
    expect(later.runAgent).toEqual([])
  })

  it('a kept pane whose agent state comes back late, even without its agent, is reattached as running, and one that never says is busy', async () => {
    const text = `${head()}nodes:
  - { id: a, kind: agent, with: { mode: start, agent: claude, prompt: p } }
edges: []
`
    let h = await hostHarness(workspace({ g: text }))
    const id = await enableAndStart(h, 'g')
    await settle()
    for (const late of [true, false]) {
      const fake = fakeExt()
      const pane = {
        paneId: 'pane-1',
        workspaceId: 'w1',
        kind: 'terminal',
        title: 'claude',
        running: true,
        blockCount: 0,
        agent: 'claude',
      }
      fake.panes.push(pane)
      h = await h.reopen(fake)
      if (late) fake.panes[0] = { ...pane, agent: undefined, running: false, agentState: 'working' }
      await h.clock.advance(6000)
      await settle()
      const verdicts = h
        .journal(id)
        .filter((l) => l.type === 'reattach')
        .map((l) => l.verdict)
      expect(verdicts.at(-1)).toBe('running')
      expect((await h.run(id))?.status).toBe('waiting')
      expect(fake.runAgent).toEqual([])
    }
  })

  it('GRF-C163 an agent that stops without a report raises NoResult 30 seconds later', async () => {
    const h = await hostHarness(
      workspace({
        g: `${head('v: { type: string, default: "" }')}nodes:
  - { id: a, kind: agent, with: { mode: start, agent: claude, prompt: p }, result: { type: object, properties: { v: { type: string } }, required: [v] }, out: { result.v: v } }
edges: []
`,
      }),
    )
    const id = await enableAndStart(h, 'g')
    await settle()
    await h.stop('pane-1')
    expect((await h.run(id))?.status).toBe('waiting')
    await h.clock.advance(29_000)
    await settle()
    expect((await h.run(id))?.status).toBe('waiting')
    await h.clock.advance(1_000)
    await settle()
    expect((await h.run(id))?.failure).toMatchObject({ node: 'a', name: 'NoResult' })
  })

  it('GRF-C168 Continue session on an interrupted agent node continues its session with the fixed prompt and waits for its report', async () => {
    const text = `${head('v: { type: string, default: "" }')}nodes:
  - { id: a, kind: agent, with: { mode: start, agent: claude, prompt: p }, result: { type: object, properties: { v: { type: string } }, required: [v] }, out: { result.v: v } }
edges: []
`
    const h = await hostHarness(workspace({ g: text }))
    const id = await enableAndStart(h, 'g')
    await settle()
    const later = await h.reopen()
    await later.clock.advance(6000)
    await settle()
    expect((await later.run(id))?.status).toBe('interrupted')
    expect(await later.runner.control('w1', id, 'continue', 'a')).toEqual({ ok: true })
    await settle()
    expect(later.runAgent[0]).toMatchObject({ continueFrom: 'pane-1', background: true })
    expect(String(later.runAgent[0].prompt)).toMatch(
      /^You were interrupted\. Finish the task and report\.\n\nWhen you have finished, report/,
    )
    expect((await later.run(id))?.view.nodes.at(-1)?.status).toBe('waiting')
    expect(await later.runner.report('pane-1', { v: 'resumed' })).toEqual({ ok: true })
    await later.stop('pane-1')
    expect((await later.run(id))?.state.v).toBe('resumed')
  })

  it('GRF-C93 a command node whose sandbox cannot start raises SandboxUnavailable', async () => {
    const h = await hostHarness(
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
    const id = await enableAndStart(h, 'g')
    await settle()
    expect((await h.run(id))?.state.e).toMatchObject({ name: 'SandboxUnavailable' })
  })

  it('a report reaches the run it names, and one that names none is refused while two runs wait on the pane', async () => {
    const text = (name: string) => `${head('v: { type: string, default: "" }')}nodes:
  - { id: a, kind: agent, with: { mode: message, to: trigger, prompt: "${name}" }, result: { type: object, properties: { v: { type: string } }, required: [v] }, out: { result.v: v } }
edges: []
`
    const h = await hostHarness(workspace({ one: text('one'), two: text('two') }))
    h.panes.push({
      paneId: 'starter',
      workspaceId: 'w1',
      kind: 'terminal',
      title: 'claude',
      running: true,
      blockCount: 0,
      agent: 'claude',
    })
    const first = await enableAndStart(h, 'one', [], 'starter')
    const second = await enableAndStart(h, 'two', [], 'starter')
    await settle()
    expect(h.busSent.map((m) => m.text.split('\n')[0]).sort()).toEqual(['one', 'two'])
    expect(h.busSent.find((m) => m.text.startsWith('one'))?.text).toContain(`--run ${first}`)
    expect(await h.runner.report('starter', { v: 'x' })).toMatchObject({
      ok: false,
      error: 'ambiguous',
    })
    expect(await h.runner.report('starter', { v: 'for one' }, first)).toEqual({ ok: true })
    expect(await h.runner.report('starter', { v: 'for two' }, second)).toEqual({ ok: true })
    await h.stop('starter')
    expect((await h.run(first))?.state.v).toBe('for one')
    expect((await h.run(second))?.state.v).toBe('for two')
  })

  it('has unfinished runs while a run is live, also for an Ostia opened again, and none once it ended', async () => {
    const h = await hostHarness(
      workspace({
        g: `${head('v: { type: string, default: "" }')}nodes:
  - { id: a, kind: agent, with: { mode: start, agent: claude, prompt: p }, result: { type: object, properties: { v: { type: string } }, required: [v] }, out: { result.v: v } }
edges: []
`,
      }),
    )
    expect(await h.runner.hasUnfinishedRuns()).toBe(false)
    await enableAndStart(h, 'g')
    await settle()
    expect(await h.runner.hasUnfinishedRuns()).toBe(true)
    const fake = fakeExt()
    fake.panes.push({
      paneId: 'pane-1',
      workspaceId: 'w1',
      kind: 'terminal',
      title: 'claude',
      running: true,
      blockCount: 0,
      agent: 'claude',
      agentState: 'working',
    })
    const later = await h.reopen(fake)
    expect(await later.runner.hasUnfinishedRuns()).toBe(true)
    expect(await later.runner.report('pane-1', { v: 'ok' })).toEqual({ ok: true })
    await later.stop('pane-1')
    expect(await later.runner.hasUnfinishedRuns()).toBe(false)
  })

  it('GRF-C202 an agent pane a finished run opened never fires its graph again, also after the runtime restarts', async () => {
    const h = await hostHarness(
      workspace({
        g: `version: 1
on: [{ manual: { agents: true } }, { agent: { state: stopped } }]
start: a
state: { n: { type: integer, default: 0 } }
nodes:
  - { id: a, kind: agent, with: { mode: start, agent: claude, prompt: "Do the task." } }
edges: []
`,
      }),
    )
    const id = await enableAndStart(h, 'g')
    await settle()
    await h.stop('pane-1')
    expect((await h.run(id))?.status).toBe('done')
    const again = await h.restart()
    await again.runner.trigger('w1', { kind: 'agent', pane: 'pane-1', state: 'stopped' })
    await settle()
    expect((await again.runner.runs('w1')).map((r) => r.runId)).toEqual([id])
    await again.runner.trigger('w1', { kind: 'agent', pane: 'pane-9', state: 'stopped' })
    await settle()
    expect(await again.runner.runs('w1')).toHaveLength(2)
  })
})
