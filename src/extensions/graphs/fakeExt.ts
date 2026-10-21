import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { connect, createServer, type Server } from 'node:net'
import { dirname, join } from 'node:path'
import type {
  AskOptions,
  ConnectionValue,
  ExecOptions,
  PaneInfo,
} from '@aurigax-ai/ostia-extension-sdk'
import { type Output, RIGHTS, type RunView } from '@aurigax-ai/wire'
import {
  FakeClock,
  runtimePlace,
  settle as settleEngine,
  testRuntime,
} from '@aurigax-ai/wire/testing'
import { type GraphsExt, GraphsRunner, type Workspace } from './runner'

type TestRuntime = Awaited<ReturnType<typeof testRuntime>>

export async function settle(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await settleEngine()
    await new Promise((r) => setTimeout(r, 15))
  }
}

export interface FakeExt {
  ext: GraphsExt
  runAgent: Parameters<GraphsExt['runAgent']>[0][]
  busSent: { to: string; text: string }[]
  woken: string[]
  asked: AskOptions[]
  execs: ExecOptions[]
  notices: { title: string; body?: string; path?: string }[]
  panes: PaneInfo[]
  refuseAgent: (
    opts: Parameters<GraphsExt['runAgent']>[0],
  ) => { ok: false; error: string; message?: string } | null
  execReply: (opts: ExecOptions) => Awaited<ReturnType<GraphsExt['exec']>>
  busReply: () => Awaited<ReturnType<GraphsExt['busSend']>>
  answer: (reply: Awaited<ReturnType<GraphsExt['ask']>>) => void
  mcpCalls: { server: string; tool: string; input: Record<string, unknown> }[]
  mcpReply: (server: string, tool: string) => Awaited<ReturnType<GraphsExt['mcpCall']>>
  connections: ConnectionValue[]
}

export function fakeExt(): FakeExt {
  const pendingAsks: ((reply: Awaited<ReturnType<GraphsExt['ask']>>) => void)[] = []
  const fake: FakeExt = {
    runAgent: [],
    busSent: [],
    woken: [],
    asked: [],
    execs: [],
    notices: [],
    panes: [],
    refuseAgent: () => null,
    busReply: () => ({ ok: true, id: 'm1', state: 'delivered' }),
    execReply: () => ({
      ok: true,
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      truncated: false,
      sandboxed: false,
    }),
    answer: (reply) => pendingAsks.shift()?.(reply),
    mcpCalls: [],
    mcpReply: (server, tool) => ({ ok: true, text: `${server}/${tool}` }),
    connections: [],
    ext: {
      runAgent: async (opts) => {
        fake.runAgent.push(opts)
        const refused = fake.refuseAgent(opts)
        if (refused) return refused
        const paneId = `pane-${fake.runAgent.length}`
        fake.panes.push({
          paneId,
          workspaceId: opts.workspaceId,
          kind: 'terminal',
          title: 'agent',
          running: true,
          blockCount: 1,
          agent: 'claude',
          agentState: 'working',
        })
        return { ok: true, paneId }
      },
      busSend: async (to, text) => {
        fake.busSent.push({ to, text })
        return fake.busReply()
      },
      wakePane: async (paneId) => {
        fake.woken.push(paneId)
        return { ok: true, outcome: 'started' }
      },
      listPanes: async () => fake.panes,
      ask: (opts, signal) =>
        new Promise((resolve) => {
          fake.asked.push(opts)
          pendingAsks.push(resolve)
          signal?.addEventListener('abort', () => resolve({ ok: true, outcome: 'closed' }))
        }),
      exec: async (opts) => {
        fake.execs.push(opts)
        return fake.execReply(opts)
      },
      notifyPanel: async (title, body, path) => {
        fake.notices.push({ title, ...(body ? { body } : {}), ...(path ? { path } : {}) })
        return { ok: true }
      },
      redact: async (texts) => texts,
      mcpCall: async (server, tool, input) => {
        fake.mcpCalls.push({ server, tool, input })
        return fake.mcpReply(server, tool)
      },
      connection: async (name) => ({
        ok: true,
        connection: fake.connections.find((c) => c.name === name) ?? null,
      }),
      wireRuntime: async () => ({ ok: false, error: 'no-runtime' }),
    },
  }
  return fake
}

interface RunSeen {
  state: Output
  status: string
  failure?: { node: string; name: string; message: string }
  view: RunView
}

export interface HostHarness extends FakeExt {
  runner: GraphsRunner
  clock: FakeClock
  runtime: TestRuntime
  workspace: Workspace
  stop: (pane: string, extra?: Output) => Promise<void>
  run: (runId: string) => Promise<RunSeen | null>
  journal: (runId: string) => { type: string; verdict?: string; node?: string }[]
  reopen: (fake?: FakeExt) => Promise<HostHarness>
  restart: () => Promise<HostHarness>
  close: () => Promise<void>
}

const open: HostHarness[] = []

export async function closeHarnesses(): Promise<void> {
  for (const h of open.splice(0)) await h.close()
}

function journalOf(runtime: TestRuntime, runId: string) {
  const root = join(runtime.paths.data, 'runs')
  for (const scope of readdirSync(root))
    for (const graph of readdirSync(join(root, scope))) {
      const path = join(root, scope, graph, runId, 'journal.jsonl')
      if (existsSync(path))
        return readFileSync(path, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l) as { type: string; verdict?: string; node?: string })
    }
  return []
}

export interface HarnessOptions {
  daemon?: boolean
  log?: (line: string) => void
  received?: Buffer[]
}

function tap(target: string, received: Buffer[]): Promise<{ socket: string; server: Server }> {
  const socket = join(dirname(target), 'tap.sock')
  const server = createServer((down) => {
    const up = connect(target)
    down.on('data', (chunk) => {
      received.push(chunk)
      up.write(chunk)
    })
    up.pipe(down)
    down.on('close', () => up.destroy())
    up.on('close', () => down.destroy())
    up.on('error', () => down.destroy())
    down.on('error', () => up.destroy())
  })
  return new Promise((resolve) => server.listen(socket, () => resolve({ socket, server })))
}

async function connected(
  fake: FakeExt,
  runtime: TestRuntime,
  workspace: Workspace,
  clock: FakeClock,
  socket: string,
  closing: () => void,
): Promise<HostHarness> {
  const token = runtime.tokens.issue('ostia', RIGHTS)
  fake.ext.wireRuntime = async () => ({
    ok: true,
    socket,
    token,
    started: false,
    mode: runtime.mode,
    version: 'test',
  })
  const runner = new GraphsRunner({ ext: fake.ext, clock, changed: () => {} })
  await runner.setWorkspaces([workspace])
  const harness: HostHarness = Object.assign(fake, {
    runner,
    clock,
    runtime,
    workspace,
    stop: async (pane: string, extra: Output = {}) => {
      await runner.stopped({ pane, ...extra })
      await settle()
    },
    run: async (runId: string): Promise<RunSeen | null> => {
      const view = await runner.view(workspace.workspaceId, runId)
      if (!view) return null
      return {
        state: view.state,
        status: view.summary.status,
        ...(view.summary.failure ? { failure: view.summary.failure } : {}),
        view,
      }
    },
    journal: (runId: string) => journalOf(runtime, runId),
    reopen: async (next: FakeExt = fakeExt()) => {
      runner.stop()
      return connected(next, runtime, workspace, clock, socket, closing)
    },
    restart: async () => {
      runner.stop()
      closing()
      await runtime.stop()
      const again = await testRuntime(runtime.paths, { clock })
      return connected(fakeExt(), again, workspace, clock, again.paths.socket, () => {})
    },
    close: async () => {
      runner.stop()
      closing()
      await runtime.stop()
    },
  })
  open.push(harness)
  await settle()
  return harness
}

export async function hostHarness(
  workspace: Workspace,
  clock = new FakeClock(),
  fake = fakeExt(),
  opts: HarnessOptions = {},
): Promise<HostHarness> {
  const { paths } = runtimePlace()
  const runtime = await testRuntime(paths, {
    clock,
    ...(opts.daemon ? { daemon: true } : {}),
    ...(opts.log ? { log: opts.log } : {}),
  })
  if (!opts.received) return connected(fake, runtime, workspace, clock, paths.socket, () => {})
  const { socket, server } = await tap(paths.socket, opts.received)
  return connected(fake, runtime, workspace, clock, socket, () => server.close())
}
