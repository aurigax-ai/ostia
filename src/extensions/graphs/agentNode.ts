import {
  type Clock,
  MESSAGE_MAX,
  type NodeContext,
  NodeError,
  type NodeKind,
  type NodeResult,
  type NodeWait,
  type Output,
  TRIGGER_TARGET,
} from '@aurigax-ai/wire'
import type { OstiaExtension, PaneInfo } from '../sdk'

export const RATE_RETRY_MS = 60_000
const LATE_REPORT_MS = 30_000
const WAKE_WAIT_MS = 120_000
export const AGENT_STOP = 'agent-stop'
export const AGENT_LATE = 'agent-late'

type AgentExt = Pick<OstiaExtension, 'runAgent' | 'busSend' | 'wakePane' | 'listPanes'>

export interface AgentDeps {
  ext: AgentExt
  clock: Clock
  takeReport: (pane: string, runId: string) => Output | null
  expectReport: (pane: string, runId: string, ms: number) => void
}

function stopWait(pane: string): NodeWait {
  return { on: 'event', match: { type: AGENT_STOP, pane } }
}

function lateWait(pane: string, run: string): NodeWait {
  return { on: 'event', match: { type: AGENT_LATE, pane, run } }
}

function sleep(clock: Clock, ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const cancel = clock.setTimer(clock.now() + ms, resolve)
    signal.addEventListener(
      'abort',
      () => {
        cancel()
        resolve()
      },
      { once: true },
    )
  })
}

function paneOf(ctx: NodeContext, node: unknown): string | undefined {
  if (node === TRIGGER_TARGET)
    return typeof ctx.trigger.pane === 'string' ? ctx.trigger.pane : undefined
  const record = ctx.started(String(node))
  const pane = record?.started?.pane ?? record?.output?.pane
  return typeof pane === 'string' ? pane : undefined
}

async function openPane(deps: AgentDeps, input: Output, ctx: NodeContext): Promise<string> {
  const prompt = String(input.prompt)
  let opts: Parameters<AgentExt['runAgent']>[0]
  if (input.mode === 'continue') {
    const from = paneOf(ctx, input.from)
    if (!from) throw new NodeError('AgentGone', `no-session: ${String(input.from)} opened no pane`)
    opts = { workspaceId: ctx.scope, continueFrom: from, prompt, background: true }
  } else {
    opts = { workspaceId: ctx.scope, agent: String(input.agent), prompt, background: true }
  }
  for (;;) {
    const res = await deps.ext.runAgent(opts)
    if (res.ok) return res.paneId
    if (res.error === 'rate-limited' && !ctx.signal.aborted) {
      await sleep(deps.clock, RATE_RETRY_MS, ctx.signal)
      continue
    }
    throw new NodeError('AgentGone', `${res.error}${res.message ? `: ${res.message}` : ''}`)
  }
}

async function message(deps: AgentDeps, input: Output, ctx: NodeContext): Promise<NodeResult> {
  const target = paneOf(ctx, input.to)
  const panes = target ? await deps.ext.listPanes() : []
  const pane = panes.find((p) => p.paneId === target && p.workspaceId === ctx.scope)
  if (!target || !pane) return { done: { outcome: 'closed' } }
  if (pane.hibernated) await deps.ext.wakePane(target, WAKE_WAIT_MS)
  const sent = await deps.ext.busSend(target, String(input.prompt))
  if (!sent.ok) {
    if (sent.error === 'unknown-pane') return { done: { outcome: 'closed' } }
    throw new NodeError('AgentGone', `${sent.error}${sent.message ? `: ${sent.message}` : ''}`)
  }
  if (input.wait === 'none') return { done: { pane: target, delivered: sent.delivered } }
  return { waiting: stopWait(target), started: { pane: target, delivered: sent.delivered } }
}

function stopOutput(event: Output, started: Output | undefined): Output {
  const outcome = event.closed === true ? 'closed' : event.exited === true ? 'exited' : 'stopped'
  const out: Output = { ...(started ?? {}), pane: event.pane, outcome }
  if (typeof event.session === 'string') out.session = event.session
  if (typeof event.message === 'string') out.message = event.message.slice(0, MESSAGE_MAX)
  return out
}

function reattachVerdict(
  pane: PaneInfo | undefined,
  started: Output | undefined,
  wait: NodeWait | undefined,
) {
  if (!pane || pane.hibernated) return 'lost' as const
  if (
    typeof started?.session === 'string' &&
    pane.agentSessionId &&
    pane.agentSessionId !== started.session
  ) {
    return 'lost' as const
  }
  if (wait?.on === 'event' && wait.match.type === AGENT_LATE) return 'running' as const
  if (pane.agentState === 'working') return 'running' as const
  if (pane.agent && pane.agentState === undefined) return 'running' as const
  return {
    done: { ...(started ?? {}), pane: pane.paneId, outcome: pane.agent ? 'stopped' : 'exited' },
  }
}

const STATE_SETTLE_MS = 5000
const STATE_POLL_MS = 250

async function settledPane(deps: AgentDeps, paneId: unknown): Promise<PaneInfo | undefined> {
  const until = deps.clock.now() + STATE_SETTLE_MS
  for (;;) {
    const pane = (await deps.ext.listPanes()).find((p) => p.paneId === paneId)
    if (!pane || pane.agentState !== undefined || deps.clock.now() >= until) return pane
    await new Promise<void>((resolve) =>
      deps.clock.setTimer(deps.clock.now() + STATE_POLL_MS, resolve),
    )
  }
}

export function agentNode(deps: AgentDeps): NodeKind {
  return {
    kind: 'agent',
    version: 1,
    start: async (input, ctx) => {
      if (input.mode === 'message') return message(deps, input, ctx)
      const pane = await openPane(deps, input, ctx)
      if (input.wait === 'none') return { done: { pane } }
      return { waiting: stopWait(pane), started: { pane } }
    },
    resume: async (wait, event, ctx) => {
      const started = ctx.started(ctx.run.node)?.started
      if (event.type === AGENT_LATE) {
        return { done: { ...(started ?? {}), ...(event.result ? { result: event.result } : {}) } }
      }
      if (event.backgroundWork === true) return { waiting: wait }
      const out = stopOutput(event, started)
      if (!ctx.node.result) return { done: out }
      const report = deps.takeReport(String(event.pane), ctx.run.id)
      if (report) return { done: { ...out, result: report } }
      if (out.outcome !== 'stopped') return { done: out }
      deps.expectReport(String(event.pane), ctx.run.id, LATE_REPORT_MS)
      return { waiting: lateWait(String(event.pane), ctx.run.id), started: out }
    },
    reattach: async (started, wait) => {
      const pane = await settledPane(deps, started?.pane)
      return reattachVerdict(pane, started, wait)
    },
  }
}
