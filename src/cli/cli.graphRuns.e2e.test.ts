import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FAKE } from '../../test/fixtures/secrets/samples'
import {
  FAKE_TOOL,
  graphsHarness,
  type Harness,
  POLL,
  SCAN_EXPLODES,
} from '../../test/graphsHarness'
import { running } from '../../test/tmux'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  webContents: { fromId: () => ({ isDestroyed: () => false, send: () => {} }) },
}))

const { questions } = await import('../main/approvals/questions')

const TOOL = JSON.stringify(FAKE_TOOL)

type Line = Record<string, unknown> & { type: string }

describe('graph runs on the built-in graphs extension (real CLI, real socket)', () => {
  let h: Harness

  const lines = (runId: string, _graph: string): Line[] => h.journal(runId) as unknown as Line[]
  const ended = (runId: string, graph: string) =>
    vi.waitUntil(() => {
      const found = lines(runId, graph)
      return found.some((l) => l.type === 'run-end') ? found : undefined
    }, POLL)
  const start = async (name: string, text: string, input: string[] = []): Promise<string> => {
    h.writeGraph(name, text)
    const enabled = await h.enable(name)
    if (!enabled.ok) throw new Error(JSON.stringify(enabled))
    const res = await h.panel('runNow', { name, inputs: input })
    if (!res.ok) throw new Error(JSON.stringify(res))
    return (res.data as { runId: string }).runId
  }
  const waitingAt = (runId: string, graph: string, node: string) =>
    vi.waitUntil(
      () => lines(runId, graph).some((l) => l.type === 'node-wait' && l.node === node),
      POLL,
    )
  const openedPane = (index: number) => vi.waitUntil(() => h.opened[index], POLL)
  const waits = (runId: string, graph: string, node: string, count: number) =>
    vi.waitUntil(
      () =>
        lines(runId, graph).filter((l) => l.type === 'node-wait' && l.node === node).length >=
        count,
      POLL,
    )
  const state = (runId: string, graph: string): Record<string, unknown> => {
    const all = lines(runId, graph)
    const last = [...all].reverse().find((l) => l.type === 'state') as
      | { state: Record<string, unknown> }
      | undefined
    return last?.state ?? {}
  }

  beforeAll(async () => {
    h = await graphsHarness({ activity: true })
  }, 120_000)

  afterAll(() => h.stopAll())

  it('GRF-C41 and GRF-C52 agents with results, a command, a router loop and an approval run end to end in order', async () => {
    const graph = `version: 1
on: [{ manual: {} }]
start: implement
state:
  summary: { type: string, default: "" }
  exit: { type: integer, default: -1 }
  verdict: { type: string, enum: [pass, fail], default: fail }
  decision: { type: string, default: "" }
nodes:
  - id: implement
    kind: agent
    with: { mode: start, agent: claude, prompt: "Implement it." }
    result: { type: object, properties: { summary: { type: string } }, required: [summary] }
    out: { result.summary: summary }
  - { id: test, kind: command, with: { run: [${TOOL}, status] }, out: { exit: exit } }
  - id: review
    kind: agent
    with: { mode: start, agent: codex, prompt: "Review it." }
    result: { type: object, properties: { verdict: { type: string, enum: [pass, fail] } }, required: [verdict] }
    out: { result.verdict: verdict }
  - { id: verdict-router, kind: router }
  - { id: ask, kind: approval, with: { question: "Open a pull request?", choices: [Open it, Stop here] }, out: { answer: decision } }
edges:
  - { from: implement, to: test }
  - { from: test, to: review }
  - { from: review, to: verdict-router }
  - from: verdict-router
    when: [{ if: "state.verdict == 'pass'", to: ask }]
    else: review
`
    const runId = await start('loop', graph)
    const implement = await openedPane(0)
    await waits(runId, 'loop', 'implement', 1)
    expect(implement.backgroundTab).toBe(true)
    expect(implement.command).toContain("ostia graph report --json '\\''<one JSON object>'\\''")
    expect((await h.cli(implement, ['graph', 'report', '--json', '{"summary":"done"}'])).code).toBe(
      0,
    )
    await h.stop(implement, { last_assistant_message: 'Implemented.' })
    const firstReview = await openedPane(1)
    await waits(runId, 'loop', 'review', 1)
    await h.cli(firstReview, ['graph', 'report', '--json', '{"verdict":"fail"}'])
    await h.stop(firstReview, {})
    const secondReview = await openedPane(2)
    await waits(runId, 'loop', 'review', 2)
    await h.cli(secondReview, ['graph', 'report', '--json', '{"verdict":"pass"}'])
    await h.stop(secondReview, {})
    await waitingAt(runId, 'loop', 'ask')
    const shown = await vi.waitUntil(
      () =>
        questions()
          ?.stateFor('7')
          .pending.find((q) => q.question === 'Open a pull request?'),
      POLL,
    )
    expect(shown.source?.extension).toBe('Graphs')
    expect(shown.context).toContain('Graph loop')
    questions()?.answer('7', shown.id, { choices: [0], text: '' })
    const all = await ended(runId, 'loop')
    expect(all.filter((l) => l.type === 'node-end').map((l) => l.node)).toEqual([
      'implement',
      'test',
      'review',
      'verdict-router',
      'review',
      'verdict-router',
      'ask',
    ])
    expect(state(runId, 'loop')).toMatchObject({
      summary: 'done',
      exit: 3,
      verdict: 'pass',
      decision: 'Open it',
    })
  })

  it('GRF-C58 an approval waits labelled Graphs and the graph’s name, and the choice becomes answer', async () => {
    const runId = await start(
      'approve',
      `version: 1
on: [{ manual: {} }]
start: ask
state: { decision: { type: string, default: "" } }
nodes:
  - { id: ask, kind: approval, with: { question: "Ship it?" }, out: { answer: decision } }
edges: []
`,
    )
    const shown = await vi.waitUntil(
      () =>
        questions()
          ?.stateFor('7')
          .pending.find((q) => q.question === 'Ship it?'),
      POLL,
    )
    expect(shown.source).toEqual({ extension: 'Graphs', workspaceId: 'w1' })
    expect(shown.context).toContain('Graph approve')
    const runs = JSON.parse((await h.cli(h.human, ['graph', 'runs', 'approve'])).stdout) as {
      status: string
    }[]
    expect(runs[0].status).toBe('waiting')
    questions()?.answer('7', shown.id, { choices: [1], text: '' })
    await ended(runId, 'approve')
    expect(state(runId, 'approve').decision).toBe('Reject')
  })

  it('GRF-C53 a message to the trigger pane reaches its bus wait at once and types nothing', async () => {
    h.writeGraph(
      'tell',
      `version: 1
on: [{ manual: { agents: true } }]
start: m
state: { delivered: { type: string, default: "" } }
nodes:
  - { id: m, kind: agent, with: { mode: message, to: trigger, prompt: "every check passed", wait: none }, out: { delivered: delivered } }
edges: []
`,
    )
    await h.enable('tell')
    const opened = h.opened.length
    const waiting = h.cli(h.human, ['bus', 'wait', '--timeout', '20000', '--json'])
    await new Promise((r) => setTimeout(r, 500))
    const run = await h.cli(h.human, ['graph', 'run', 'tell'])
    const got = JSON.parse((await waiting).stdout) as { messages: { text: string; from: string }[] }
    expect(got.messages.map((m) => [m.text, m.from])).toEqual([['every check passed', 'graphs']])
    await ended(run.stdout.trim(), 'tell')
    expect(state(run.stdout.trim(), 'tell').delivered).toBe('delivered')
    expect(h.opened.length).toBe(opened)
  })

  it('GRF-C23 an argv element with shell text reaches the program as one argument', async () => {
    const runId = await start(
      'argv',
      `version: 1
on: [{ manual: {} }]
start: a
state: { pr: { type: string, default: "12; rm -rf ~ $(id)" }, out: { type: string, default: "" } }
nodes:
  - { id: a, kind: command, with: { run: [${TOOL}, argv, checks, "{{state.pr}}"] }, out: { stdout: out } }
edges: []
`,
    )
    await ended(runId, 'argv')
    expect(JSON.parse(String(state(runId, 'argv').out))).toEqual(['checks', '12; rm -rf ~ $(id)'])
  })

  it('GRF-C57 a timeout ends the process, a large output is cut, a missing program and a failed exit are errors', async () => {
    const pids = join(h.dir, 'pids')
    const runId = await start(
      'faults',
      `version: 1
on: [{ manual: {} }]
start: [slow, big, missing, failing]
state:
  e1: { type: object, default: {} }
  e3: { type: object, default: {} }
  e4: { type: object, default: {} }
  cut: { type: boolean, default: false }
  size: { type: string, default: "", max: 65536 }
nodes:
  - { id: slow, kind: command, timeout: 2s, with: { run: [${TOOL}, sleep-child, ${JSON.stringify(pids)}] }, out: { error: e1 }, catch: [{ errors: [All], then: continue }] }
  - { id: big, kind: command, with: { run: [${TOOL}, big] }, out: { truncated: cut, stdout: size } }
  - { id: missing, kind: command, with: { run: [/nonexistent/tool] }, out: { error: e3 }, catch: [{ errors: [All], then: continue }] }
  - { id: failing, kind: command, with: { run: [${TOOL}, write, /dev/null, x, extra], exitIsError: true }, out: { error: e4 }, catch: [{ errors: [All], then: continue }] }
edges: []
`.replace(`${TOOL}, write, /dev/null, x, extra]`, `${TOOL}, nope]`),
    )
    await ended(runId, 'faults')
    const s = state(runId, 'faults')
    expect(s.e1).toMatchObject({ name: 'Timeout' })
    const [parent, child] = readFileSync(pids, 'utf8').trim().split(' ').map(Number)
    await vi.waitUntil(() => !running(parent as number) && !running(child as number), {
      timeout: 8000,
      interval: 50,
    })
    expect(s.cut).toBe(true)
    expect(String(s.size).length).toBe(64 * 1024)
    expect(s.e3).toMatchObject({ name: 'BadOutput' })
    expect(String((s.e3 as { message: string }).message)).toContain('spawn-failed')
    expect(s.e4).toMatchObject({ name: 'ExitCode' })
  })

  it('GRF-C62 a notify node sends one notification that opens the panel at its run', async () => {
    const before = h.notices.length
    const runId = await start(
      'tell-me',
      `version: 1
on: [{ manual: {} }]
start: n
state: { who: { type: string, default: "the reviewer" } }
nodes:
  - { id: n, kind: notify, with: { title: Done, body: "Approved by {{state.who}}" } }
edges: []
`,
    )
    await ended(runId, 'tell-me')
    await vi.waitUntil(() => h.notices.length > before, POLL)
    await new Promise((r) => setTimeout(r, 300))
    const sent = h.notices.slice(before)
    expect(sent).toEqual([
      { title: 'Done', body: 'Approved by the reviewer', panelPath: `/?run=${runId}` },
    ])
  })

  it('GRF-C74 Pause lets the running command end and keep its result; Resume goes on', async () => {
    const runId = await start(
      'pausing',
      `version: 1
on: [{ manual: {} }]
start: a
state: { first: { type: string, default: "" } }
nodes:
  - { id: a, kind: command, with: { run: [${TOOL}, sleep, "1"] } }
  - { id: b, kind: command, with: { run: [${TOOL}, status] } }
edges:
  - { from: a, to: b }
`,
    )
    await vi.waitUntil(
      () => lines(runId, 'pausing').some((l) => l.type === 'node-start' && l.node === 'a'),
      POLL,
    )
    expect(await h.panel('control', { runId, action: 'pause' })).toEqual({ ok: true })
    await vi.waitUntil(
      () => lines(runId, 'pausing').some((l) => l.type === 'node-end' && l.node === 'a'),
      POLL,
    )
    await new Promise((r) => setTimeout(r, 300))
    expect(lines(runId, 'pausing').some((l) => l.type === 'node-start' && l.node === 'b')).toBe(
      false,
    )
    expect(await h.panel('control', { runId, action: 'resume' })).toEqual({ ok: true })
    const all = await ended(runId, 'pausing')
    expect(all.filter((l) => l.type === 'node-end').map((l) => l.node)).toEqual(['a', 'b'])
  })

  it('GRF-C75 ostia graph show --node prints a node’s input, output, errors, retries and the state after it', async () => {
    const runId = await start(
      'shown',
      `version: 1
on: [{ manual: {} }]
start: test
state: { exit: { type: integer, default: -1 } }
nodes:
  - { id: test, kind: command, with: { run: [${TOOL}, status] }, out: { exit: exit } }
edges: []
`,
    )
    await ended(runId, 'shown')
    const shown = JSON.parse(
      (await h.cli(h.human, ['graph', 'show', runId, '--node', 'test'])).stdout,
    ) as {
      nodes: Record<string, unknown>[]
    }
    expect(shown.nodes).toHaveLength(1)
    expect(shown.nodes[0]).toMatchObject({
      node: 'test',
      status: 'done',
      retries: [],
      stateAfter: { exit: 3 },
    })
    expect(shown.nodes[0].input).toMatchObject({ run: [FAKE_TOOL, 'status'] })
    expect(shown.nodes[0].output).toMatchObject({ exit: 3 })
  })

  it('GRF-C77 Cancel ends a running command and leaves the agent; Retry reruns only the failed node', async () => {
    const pids = join(h.dir, 'cancel-pids')
    const opened = h.opened.length
    const runId = await start(
      'cancelled',
      `version: 1
on: [{ manual: {} }]
start: [cmd, agent]
state: { n: { type: integer, default: 0 } }
nodes:
  - { id: cmd, kind: command, timeout: 5m, with: { run: [${TOOL}, sleep-child, ${JSON.stringify(pids)}] } }
  - { id: agent, kind: agent, with: { mode: start, agent: claude, prompt: work } }
edges: []
`,
    )
    const pane = await openedPane(opened)
    await vi.waitUntil(() => existsSync(pids), POLL)
    expect(await h.panel('control', { runId, action: 'cancel' })).toEqual({ ok: true })
    const all = await ended(runId, 'cancelled')
    expect(all.at(-1)).toMatchObject({ type: 'run-end', status: 'cancelled' })
    const [parent, child] = readFileSync(pids, 'utf8').trim().split(' ').map(Number)
    await vi.waitUntil(() => !running(parent as number) && !running(child as number), {
      timeout: 8000,
      interval: 50,
    })
    expect(h.panes.has(pane.internalId)).toBe(true)

    const counter = join(h.dir, 'retry-count')
    const retried = await start(
      'retried',
      `version: 1
on: [{ manual: {} }]
start: first
state: { n: { type: integer, default: 0 } }
nodes:
  - { id: first, kind: command, with: { run: [${TOOL}, status] } }
  - { id: flaky, kind: command, with: { run: [${TOOL}, fail-times, ${JSON.stringify(counter)}, "1"], exitIsError: true } }
edges:
  - { from: first, to: flaky }
`,
    )
    await vi.waitUntil(() => lines(retried, 'retried').some((l) => l.type === 'run-end'), POLL)
    expect(await h.panel('control', { runId: retried, action: 'retry' })).toEqual({ ok: true })
    await vi.waitUntil(
      () => lines(retried, 'retried').filter((l) => l.type === 'run-end').length === 2,
      POLL,
    )
    const starts = lines(retried, 'retried')
      .filter((l) => l.type === 'node-start')
      .map((l) => l.node)
    expect(starts).toEqual(['first', 'flaky', 'flaky'])
    expect(lines(retried, 'retried').at(-1)).toMatchObject({ type: 'run-end', status: 'done' })
  })

  it('GRF-C79 a secret in a command’s output is redacted in the state and the journal; a failed scan writes nothing', async () => {
    const secretFile = join(h.dir, 'secret.txt')
    writeFileSync(secretFile, `token=${FAKE.githubClassic}\n`)
    const runId = await start(
      'secret',
      `version: 1
on: [{ manual: {} }]
start: a
state: { out: { type: string, default: "" } }
nodes:
  - { id: a, kind: command, with: { run: [${TOOL}, read, ${JSON.stringify(secretFile)}] }, out: { stdout: out } }
edges: []
`,
    )
    await ended(runId, 'secret')
    const journalText = JSON.stringify(h.journal(runId))
    expect(journalText).not.toContain(FAKE.githubClassic)
    expect(String(state(runId, 'secret').out)).toMatch(/\[redacted:[^\]]+\]/)

    const exploding = join(h.dir, 'explodes.txt')
    writeFileSync(exploding, `${SCAN_EXPLODES}\n`)
    const failed = await start(
      'unscanned',
      `version: 1
on: [{ manual: {} }]
start: a
state: { out: { type: string, default: "" } }
nodes:
  - { id: a, kind: command, with: { run: [${TOOL}, read, ${JSON.stringify(exploding)}] }, out: { stdout: out } }
edges: []
`,
    )
    const all = await ended(failed, 'unscanned')
    expect(all.find((l) => l.type === 'node-end')).toMatchObject({
      status: 'failed',
      error: { name: 'RedactionFailed' },
    })
    expect(JSON.stringify(all)).not.toContain(SCAN_EXPLODES)
  })

  it('GRF-C88 a node that edits its own file finishes on its stored definition and leaves the graph disabled', async () => {
    const own = join(h.workDir, '.ostia/graphs/self-edit.yaml')
    const second = join(h.workDir, '.ostia/graphs/sneaky.yaml')
    const text = `version: 1
on: [{ manual: {} }]
start: a
state: { n: { type: integer, default: 0 } }
nodes:
  - { id: a, kind: command, with: { run: [${TOOL}, write, ${JSON.stringify(own)}, "version: 1"] } }
  - { id: b, kind: command, with: { run: [${TOOL}, write, ${JSON.stringify(second)}, "version: 1"] } }
  - { id: c, kind: notify, with: { title: "still ran" } }
edges:
  - { from: a, to: b }
  - { from: b, to: c }
`
    const runId = await start('self-edit', text)
    const all = await ended(runId, 'self-edit')
    expect(all.filter((l) => l.type === 'node-end').map((l) => l.node)).toEqual(['a', 'b', 'c'])
    const list = JSON.parse((await h.cli(h.human, ['graph', 'list'])).stdout) as {
      name: string
      state: string
    }[]
    expect(list.find((g) => g.name === 'self-edit')?.state).not.toBe('enabled')
    expect(list.find((g) => g.name === 'sneaky')?.state).not.toBe('enabled')
  })

  it('GRF-C162 and GRF-C163 routing reads the report, never the closing message; a bad report is refused and can be sent again', async () => {
    const before = h.opened.length
    const runId = await start(
      'verdicts',
      `version: 1
on: [{ manual: {} }]
start: review
state: { verdict: { type: string, default: "" } }
nodes:
  - id: review
    kind: agent
    with: { mode: start, agent: claude, prompt: "Review." }
    result: { type: object, properties: { verdict: { type: string, enum: [pass, fail] }, findings: { type: array, items: { type: string } } }, required: [verdict, findings] }
    out: { result.verdict: verdict }
  - { id: passed, kind: notify, with: { title: passed } }
  - { id: failed, kind: notify, with: { title: failed } }
edges:
  - from: review
    when: [{ if: "state.verdict == 'pass'", to: passed }]
    else: failed
`,
    )
    const pane = await openedPane(before)
    await waits(runId, 'verdicts', 'review', 1)
    const maybe = await h.cli(pane, [
      'graph',
      'report',
      '--json',
      '{"verdict":"maybe","findings":[]}',
    ])
    expect(maybe.code).toBe(1)
    expect(maybe.stderr).toContain('verdict must be one of pass, fail')
    expect(
      (await h.cli(pane, ['graph', 'report', '--json', '{"verdict":"fail","findings":["x"]}']))
        .code,
    ).toBe(0)
    await h.stop(pane, { last_assistant_message: 'VERDICT: pass' })
    const all = await ended(runId, 'verdicts')
    expect(all.filter((l) => l.type === 'node-end').map((l) => l.node)).toEqual([
      'review',
      'failed',
    ])
    expect(all.filter((l) => l.type === 'node-report').map((l) => l.valid)).toEqual([false, true])
  })

  it('GRF-C164 a report from a pane no node waits for changes nothing', async () => {
    const res = await h.cli(h.human, ['graph', 'report', '--json', '{}'])
    expect(res.code).toBe(1)
    expect(res.stderr).toContain('no-waiting-node')
    const other = await h.cli(h.opened[0] as Harness['human'], [
      'graph',
      'report',
      '--json',
      '{"summary":"late"}',
    ])
    expect(other.stderr).toContain('no-waiting-node')
  })

  it('GRF-C165 a continue node forks the session of a live pane and resumes it once that agent exited', async () => {
    const graph = (name: string) => `version: 1
on: [{ manual: {} }]
start: implement
state: { n: { type: integer, default: 0 } }
nodes:
  - { id: implement, kind: agent, with: { mode: start, agent: claude, prompt: "Implement ${name}.", wait: none } }
  - { id: fix, kind: agent, with: { mode: continue, from: implement, prompt: "Fix the 'flaky' test", wait: none } }
edges:
  - { from: implement, to: fix }
`
    for (const [name, exited] of [
      ['forked', false],
      ['resumed', true],
    ] as const) {
      const opened = h.opened.length
      h.onOpen = (pane) => {
        if (h.opened.length !== opened + 1) return
        pane.agentSessionId = `sess-${name}`
        if (exited) pane.agent = undefined
        h.resumes.set(pane.externalId, { agent: 'claude', id: `sess-${name}`, cwd: h.workDir })
      }
      const runId = await start(name, graph(name))
      await ended(runId, name)
      const [first, second] = [h.opened[opened], h.opened[opened + 1]]
      expect(first?.command).toBe(`claude 'Implement ${name}.'`)
      expect(second?.command).toBe(
        exited
          ? `'claude' --resume sess-${name} 'Fix the '\\''flaky'\\'' test'`
          : `'claude' --resume sess-${name} --fork-session 'Fix the '\\''flaky'\\'' test'`,
      )
      expect(second?.cwd).toBe(h.workDir)
    }
    h.onOpen = () => {}
  })

  it('GRF-C178 a command on its second visit and its retry share one attempt key ending :2', async () => {
    const log = join(h.dir, 'visits.log')
    const runId = await start(
      'visits',
      `version: 1
on: [{ manual: {} }]
start: c
state: { n: { type: integer, default: 0 } }
nodes:
  - { id: c, kind: command, with: { run: [${TOOL}, visit-log, ${JSON.stringify(log)}, "2"], exitIsError: true }, retry: [{ errors: [ExitCode], maxAttempts: 1, interval: 100ms }] }
  - { id: r, kind: router }
edges:
  - { from: c, to: r }
  - from: r
    when: [{ if: "run.visits.c < 2", to: c }]
    else: end
`,
    )
    await ended(runId, 'visits')
    const rows = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((l) => l.split(' '))
    expect(rows.map((r) => [r[1], r[2]?.split(':').slice(-1)[0], r[3]])).toEqual([
      ['c', '1', '1'],
      ['c', '2', '1'],
      ['c', '2', '2'],
    ])
    expect(rows.every((r) => r[0] === runId)).toBe(true)
    expect(rows[1]?.[2]).toBe(rows[2]?.[2])
  })

  it('GRF-C131 Activity and Graphs both take one agent’s stop, and Graphs still does with Activity off', async () => {
    const graph = `version: 1
on: [{ manual: {} }]
start: a
state: { message: { type: string, default: "" } }
nodes:
  - { id: a, kind: agent, with: { mode: start, agent: claude, prompt: "Work." }, out: { message: message } }
edges: []
`
    const opened = h.opened.length
    const runId = await start('shared-stop', graph)
    const pane = await openedPane(opened)
    const stop = JSON.stringify({ session_id: 's-9', last_assistant_message: 'All green.' })
    await h.cli(pane, ['activity', 'on-hook', 'claude', 'Stop'], stop)
    await h.cli(pane, ['graph', 'on-stop', 'claude', 'Stop'], stop)
    await ended(runId, 'shared-stop')
    expect(state(runId, 'shared-stop').message).toBe('All green.')
    const journalDir = join(h.dataDir, 'activity', 'journal')
    await vi.waitUntil(() => existsSync(journalDir) && readdirSync(journalDir).length > 0, POLL)
    expect(readFileSync(join(journalDir, 'w1.jsonl'), 'utf8')).toContain('All green.')

    h.host.processes.setEnabled('activity', false)
    const second = await start('shared-stop-2', graph)
    const next = await openedPane(opened + 1)
    await h.cli(next, ['graph', 'on-stop', 'claude', 'Stop'], stop)
    await ended(second, 'shared-stop-2')
    expect(state(second, 'shared-stop-2').message).toBe('All green.')
    mkdirSync(join(h.dir, 'unused'), { recursive: true })
  })

  it('GRF-C42 a loop that never ends stops at its step limit with one notification', async () => {
    const before = h.notices.length
    const runId = await start(
      'spin',
      `version: 1
on: [{ manual: {} }]
start: a
state: { n: { type: integer, default: 0 } }
limits: { steps: 4 }
nodes:
  - { id: a, kind: command, with: { run: [${TOOL}, status] } }
  - { id: b, kind: router }
edges:
  - { from: a, to: b }
  - from: b
    when: [{ if: "state.n == 1", to: end }]
    else: a
`,
    )
    const all = await ended(runId, 'spin')
    expect(all.filter((l) => l.type === 'node-start')).toHaveLength(4)
    expect(all.at(-1)).toMatchObject({ type: 'run-end', status: 'step-limit' })
    await vi.waitUntil(() => h.notices.length > before, POLL)
    await new Promise((r) => setTimeout(r, 300))
    expect(h.notices.slice(before).filter((n) => n.title.includes('spin'))).toHaveLength(1)
  })

  it('GRF-C102 the log holds no prompt, argv, output or state of a run', async () => {
    const runId = await start(
      'quiet-log',
      `version: 1
on: [{ manual: {} }]
start: a
state: { out: { type: string, default: "" } }
nodes:
  - { id: a, kind: command, with: { run: [${TOOL}, argv, "a very private argument"] }, out: { stdout: out } }
  - { id: b, kind: notify, with: { title: "a private title", body: "{{state.out}}" } }
edges:
  - { from: a, to: b }
`,
    )
    await ended(runId, 'quiet-log')
    await new Promise((r) => setTimeout(r, 300))
    const text = h.logs.join('\n')
    for (const secret of [
      'a very private argument',
      'a private title',
      FAKE_TOOL,
      'Implement it.',
    ]) {
      expect(text).not.toContain(secret)
    }
  })

  it('GRF-C2 with the extension off the verb is unknown and nothing goes on; on again, a waiting run is taken up', async () => {
    const runId = await start(
      'paused-by-off',
      `version: 1
on: [{ manual: {} }]
start: ask
state: { decision: { type: string, default: "" } }
nodes:
  - { id: ask, kind: approval, with: { question: "Still there?" }, out: { answer: decision } }
edges: []
`,
    )
    await vi.waitUntil(
      () =>
        questions()
          ?.stateFor('7')
          .pending.find((q) => q.question === 'Still there?'),
      POLL,
    )
    h.host.processes.setEnabled('graphs', false)
    await vi.waitUntil(
      () =>
        !questions()
          ?.stateFor('7')
          .pending.some((q) => q.question === 'Still there?'),
      POLL,
    )
    const off = await h.cli(h.human, ['graph', 'list'])
    expect(off.code).toBe(1)
    expect(off.stderr).toContain('ostia graph: the graphs extension is not enabled')
    h.host.processes.setEnabled('graphs', true)
    await h.cli(h.human, ['graph', 'list'])
    const again = await vi.waitUntil(
      () =>
        questions()
          ?.stateFor('7')
          .pending.find((q) => q.question === 'Still there?'),
      POLL,
    )
    questions()?.answer('7', again.id, { choices: [0], text: '' })
    await ended(runId, 'paused-by-off')
    expect(state(runId, 'paused-by-off').decision).toBe('Approve')
    expect(
      lines(runId, 'paused-by-off').some((l) => l.type === 'reattach' && l.node === 'ask'),
    ).toBe(true)
  })
})
