import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runCli as headless } from '@aurigax-ai/wire'
import { WORKED_GRAPHS, workedGraph } from '@aurigax-ai/wire/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FAKE_TOOL, graphsHarness, type Harness, POLL } from '../../test/graphsHarness'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  webContents: { fromId: () => ({ isDestroyed: () => false, send: () => {} }) },
}))

const json = (text: string) => JSON.parse(text) as Record<string, unknown>

function journal(h: Harness, runId: string): Record<string, unknown>[] {
  return h.journal(runId)
}

const AGENTS_GRAPH = (name: string, extra = '') => `version: 1
description: ${name}
on: [{ manual: { agents: true, input: [task] } }]
start: a
state:
  task: { type: string }
  exit: { type: integer, default: -1 }
${extra}nodes:
  - { id: a, kind: command, with: { run: [${JSON.stringify(FAKE_TOOL)}, status] }, out: { exit: exit } }
edges: []
`

describe('ostia graph on the built-in graphs extension (real CLI, real socket)', () => {
  let h: Harness

  beforeAll(async () => {
    h = await graphsHarness()
    for (const name of WORKED_GRAPHS) h.writeGraph(name, workedGraph(name))
  }, 120_000)

  afterAll(() => h.stopAll())

  it('GRF-C1 and GRF-C127 the verbs answer under graph only, and ostia docs lists all ten', async () => {
    const schema = await h.cli(h.human, ['graph', 'schema'])
    expect(schema.code).toBe(0)
    expect(json(schema.stdout).title).toBe('Graph file')
    const byId = await h.cli(h.human, ['graphs', 'schema'])
    expect(byId.code).toBe(1)
    expect(byId.stdout).toBe('')
    expect(byId.stderr).toContain('usage: ostia graph <command>')
    expect((await h.cli(h.human, ['graph', 'nodes'])).code).toBe(0)
    expect(
      (await h.cli(h.human, ['graph', 'explain', '.ostia/graphs/review-loop.yaml'])).stdout,
    ).toContain('graph review-loop')
    expect((await h.cli(h.human, ['graph', 'list'])).code).toBe(0)
    const docs = await h.cli(h.human, ['docs'])
    for (const verb of [
      'validate',
      'schema',
      'nodes',
      'explain',
      'dry-run',
      'list',
      'runs',
      'show',
      'run',
      'report',
    ]) {
      expect(docs.stdout).toContain(`ostia graph ${verb}`)
    }
  })

  it('GRF-C10 and GRF-C180 ostia graph validate answers exactly as the headless graph-engine does', async () => {
    writeFileSync(join(h.workDir, '.ostia/graphs/broken.yaml'), 'version: 2\n')
    writeFileSync(join(h.workDir, '.ostia/graphs/Bad_Name.yaml'), 'version: 1\n')
    const ok = await h.cli(h.human, ['graph', 'validate', '.ostia/graphs/review-loop.yaml'])
    expect(ok.code).toBe(0)
    expect(json(ok.stdout)).toEqual({ ok: true, name: 'review-loop', nodes: 8, edges: 6 })
    for (const file of [...WORKED_GRAPHS.map((n) => `${n}.yaml`), 'broken.yaml', 'Bad_Name.yaml']) {
      const ours = await h.cli(h.human, ['graph', 'validate', `.ostia/graphs/${file}`])
      const theirs = await headless(['validate', `.ostia/graphs/${file}`], h.workDir)
      if (theirs.exitCode === 0) expect(ours.stdout.trim()).toBe(theirs.stdout.trim())
      else {
        expect(ours.code).toBe(1)
        expect(ours.stdout.trim()).toBe(theirs.stdout.trim())
      }
    }
  })

  it('GRF-C45 ostia graph nodes lists the kinds Ostia runs with their contract fields', async () => {
    const kinds = JSON.parse((await h.cli(h.human, ['graph', 'nodes'])).stdout) as Record<
      string,
      unknown
    >[]
    expect(kinds.map((k) => k.kind).sort()).toEqual([
      'agent',
      'approval',
      'command',
      'connector',
      'notify',
      'router',
      'wait',
    ])
    for (const kind of kinds) {
      for (const field of ['version', 'title', 'effect', 'sandbox', 'once', 'fields', 'outputs'])
        expect(kind).toHaveProperty(field)
    }
  })

  it('GRF-C80 a valid graph nobody enabled is listed as Not enabled and an agent cannot start it', async () => {
    h.writeGraph('quiet', AGENTS_GRAPH('quiet'))
    const list = JSON.parse((await h.cli(h.human, ['graph', 'list'])).stdout) as {
      name: string
      state: string
    }[]
    expect(list.find((g) => g.name === 'quiet')?.state).toBe('not-enabled')
    const run = await h.cli(h.human, ['graph', 'run', 'quiet', '--input', 'task=x'])
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('not-enabled')
    expect(h.runIds('quiet')).toEqual([])
  })

  it('GRF-C89 and GRF-C56 an agent starts an enabled graph with input; the command runs with no terminal', async () => {
    h.writeGraph(
      'status',
      AGENTS_GRAPH('status').replace(
        'edges: []',
        `  - { id: three, kind: notify, with: { title: "exit three" } }
edges:
  - from: a
    when: [{ if: "state.exit == 3", to: three }]
    else: end`,
      ),
    )
    expect(await h.enable('status')).toEqual({ ok: true })
    const opened = h.opened.length
    const run = await h.cli(h.human, [
      'graph',
      'run',
      'status',
      '--input',
      'task=fix the flaky test',
    ])
    expect(run.code).toBe(0)
    const runId = run.stdout.trim()
    const lines = await vi.waitUntil(() => {
      const found = journal(h, runId)
      return found.some((l) => l.type === 'run-end') ? found : undefined
    }, POLL)
    expect(lines[0]).toMatchObject({
      type: 'run-start',
      state: { task: 'fix the flaky test' },
      trigger: { pane: h.human.externalId },
    })
    const end = lines.find((l) => l.type === 'node-end' && l.node === 'a') as {
      output: Record<string, unknown>
    }
    expect(end.output).toMatchObject({ exit: 3, timedOut: false })
    expect(String(end.output.stdout).trim().split('\n')).toHaveLength(3)
    expect(lines.some((l) => l.type === 'edge' && l.to === 'three' && l.outcome === 'taken')).toBe(
      true,
    )
    expect(h.opened.length).toBe(opened)
  })

  it('GRF-C90 refusals: not enabled, not for agents, no manual trigger, missing and bad input', async () => {
    h.writeGraph('human-only', AGENTS_GRAPH('human-only').replace('agents: true, ', ''))
    h.writeGraph(
      'typed',
      AGENTS_GRAPH('typed').replace(
        'exit: { type: integer, default: -1 }',
        'exit: { type: integer, default: -1 }\n  count: { type: integer, default: 0 }',
      ),
    )
    await h.enable('human-only')
    await h.enable('typed')
    const code = async (args: string[]) => (await h.cli(h.human, ['graph', 'run', ...args])).stderr
    expect(await code(['quiet', '--input', 'task=x'])).toContain('not-enabled')
    expect(await code(['human-only', '--input', 'task=x'])).toContain('not-for-agents')
    expect(await code(['typed'])).toContain('missing-input')
    expect(await code(['typed', '--input', 'task=x', '--input', 'count=many'])).toContain(
      'bad-input',
    )
  })

  it('GRF-C91 another workspace, a remote pane and the manager pane cannot start it', async () => {
    const err = async (pane: Harness['human']) =>
      (await h.cli(pane, ['graph', 'run', 'status', '--input', 'task=x'])).stderr
    expect(await err(h.stranger)).toContain('unknown-graph')
    expect(await err(h.remotePane)).toContain('remote')
    expect(await err(h.managerPane)).toContain('not-available')
  })

  it('GRF-C94 a scratch workspace has no graphs and leaves no data folder', async () => {
    expect((await h.cli(h.scratchPane, ['graph', 'list'])).stderr).toContain('scratch')
    expect((await h.cli(h.scratchPane, ['graph', 'run', 'status'])).stderr).toContain('scratch')
    const scopes = join(h.wireData, 'scopes.json')
    expect(existsSync(scopes) ? readFileSync(scopes, 'utf8') : '').not.toContain(
      join(h.dir, 'scratch'),
    )
  })

  it('GRF-C82 no verb, command or invoke enables a graph', async () => {
    const before = readFileSync(join(h.wireData, 'enabled.json'), 'utf8')
    expect((await h.cli(h.human, ['graph', 'enable', 'quiet'])).stderr).toContain(
      'usage: ostia graph <verb>',
    )
    expect((await h.cli(h.human, ['graphs', 'enable', 'quiet'])).stderr).toContain(
      'usage: ostia graph <command>',
    )
    const manifest = JSON.parse(readFileSync(join(h.dir, 'builtin/graphs/ostia.json'), 'utf8')) as {
      contributes: { commands: { id: string }[] }
    }
    for (const { id } of manifest.contributes.commands) {
      if (id === 'run' || id === 'open') continue
      await h.cli(h.human, ['graph', id, 'quiet', '--json', '{}'])
    }
    const invoke = await h.host.invoke(
      'graphs',
      'enable',
      { argv: ['quiet'] },
      { kind: 'pane', capabilities: [] },
    )
    expect(invoke).toMatchObject({ ok: false, error: 'unknown-command' })
    expect(readFileSync(join(h.wireData, 'enabled.json'), 'utf8')).toBe(before)
  })

  it('GRF-C76 pause, cancel, retry and resume-once are not commands', async () => {
    for (const verb of ['pause', 'cancel', 'retry', 'resume-once', 'resume', 'skip']) {
      expect((await h.cli(h.human, ['graph', verb, 'x'])).stderr).toContain(
        'usage: ostia graph <verb>',
      )
      expect(
        await h.host.invoke('graphs', verb, { argv: [] }, { kind: 'pane', capabilities: [] }),
      ).toMatchObject({
        error: 'unknown-command',
      })
    }
  })

  it('GRF-C84 one changed character disables an enabled graph before its next run', async () => {
    h.writeGraph('edited', AGENTS_GRAPH('edited'))
    await h.enable('edited')
    h.writeGraph(
      'edited',
      AGENTS_GRAPH('edited').replace('description: edited', 'description: editeD'),
    )
    expect(
      (await h.cli(h.human, ['graph', 'run', 'edited', '--input', 'task=x'])).stderr,
    ).toContain('not-enabled')
    const list = await h.panel('list')
    expect(
      (list.data as { graphs: { name: string; state: string }[] }).graphs.find(
        (g) => g.name === 'edited',
      )?.state,
    ).toBe('changed')
    const records = JSON.parse(readFileSync(join(h.wireData, 'enabled.json'), 'utf8')) as {
      enabled: { realPath: string }[]
    }
    expect(records.enabled.map((r) => r.realPath).join('\n')).not.toContain('edited.yaml')
  })

  it('GRF-C83 the panel API refuses a request without its secret', async () => {
    const source = await h.host.panels.resolvePanel('graphs', { workspaceId: 'w1', locale: 'en' })
    if (!source.ok) throw new Error(source.error)
    const res = await fetch(new URL('/api', source.src), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'enable', args: { name: 'quiet' } }),
    })
    expect(res.status).toBe(403)
  })
})
