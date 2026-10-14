import { MemoryJournalStore, type Output } from '@aurigax-ai/graph'
import { FakeClock, settle } from '@aurigax-ai/graph/testing'
import type { AskOptions, ExecOptions, PaneInfo } from '../sdk'
import { type GraphsExt, GraphsRunner, type Workspace } from './runner'

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
  answer: (reply: Awaited<ReturnType<GraphsExt['ask']>>) => void
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
        return { ok: true, id: 'm1', delivered: 'waiting' }
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
    },
  }
  return fake
}

export interface HostHarness extends FakeExt {
  runner: GraphsRunner
  clock: FakeClock
  store: MemoryJournalStore
  workspace: Workspace
  stop: (pane: string, extra?: Output) => Promise<void>
}

export function hostHarness(
  workspace: Workspace,
  store = new MemoryJournalStore(),
  clock = new FakeClock(),
): HostHarness {
  const fake = fakeExt()
  const runner = new GraphsRunner({ ext: fake.ext, dataDir: null, clock, store, changed: () => {} })
  runner.setWorkspaces([workspace])
  return Object.assign(fake, {
    runner,
    clock,
    store,
    workspace,
    stop: async (pane: string, extra: Output = {}) => {
      await runner.stopped({ pane, ...extra })
      await settle()
    },
  })
}
