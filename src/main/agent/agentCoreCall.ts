import type { AgentToolReply } from '@aurigax-ai/ostia-extension-sdk/contract/agent'
import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import { CancellationTokenSource, Emitter } from 'vscode-jsonrpc/node'
import { type AgentCoreToolName, isAgentCoreTool } from '../../shared/agent/agentCoreTools'
import { busInboxText } from '../../shared/agents/busMessages'
import { otherPaneText } from '../../shared/agents/paneText'
import { readPlaybook } from '../../shared/agents/playbookRead'
import { parsePlaybooks } from '../../shared/agents/playbooks'
import { initCaps } from '../approvals/capabilityStore'
import type { ControlConn, ControlMethodContext } from '../control/controlServer'
import type { PaneIdentity } from '../control/idRegistry'

export interface CoreScope {
  paneId: string
  windowId: string
  workspaceId: string
}

export interface CoreLifecycle {
  conn: ControlConn
  token: ControlMethodContext['token']
  end: () => void
}

export function coreLifecycle(): CoreLifecycle {
  const closed = new Emitter<void>()
  const disposed = new Emitter<void>()
  const source = new CancellationTokenSource()
  return {
    conn: { onClose: closed.event, onDispose: disposed.event },
    token: source.token,
    end: () => {
      source.cancel()
      closed.fire()
      disposed.fire()
      closed.dispose()
      disposed.dispose()
      source.dispose()
    },
  }
}

export interface AgentCoreDeps {
  identityOf: (paneId: string) => PaneIdentity | undefined
  sandboxed: (workspaceId: string) => boolean
  ownsChild: (ownerPaneId: string, externalPaneId: string) => boolean
  isManagerSession: (paneId: string) => boolean
  call: (name: string, params: unknown, ctx: ControlMethodContext) => Promise<unknown>
  playbookSettings: () => unknown
}

export interface CoreCallRequest {
  scope: CoreScope
  name: string
  input: Record<string, unknown>
  lifecycle: CoreLifecycle
}

type Call = (method: string, params: unknown) => Promise<unknown>

interface Facts {
  paneId: string
  ownsChild: AgentCoreDeps['ownsChild']
  playbookSettings: AgentCoreDeps['playbookSettings']
}

interface CoreTool {
  methods: readonly string[]
  run: (input: Record<string, unknown>, call: Call, facts: Facts) => Promise<unknown>
}

const REFUSED: AgentToolReply = {
  ok: false,
  error: 'This chat is not the pane it was opened for, so it cannot reach other panes.',
}
const SANDBOXED: AgentToolReply = {
  ok: false,
  error: 'The Agent is not available in a sandboxed workspace.',
}
const BAD_TOOL: AgentToolReply = { ok: false, error: 'invalid' }

function strings(input: Record<string, unknown>, keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string') out[key] = value
  }
  return out
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

interface HandedMessages {
  text: string
  lease: string | undefined
}

function handed(value: unknown): HandedMessages {
  const record = isRecord(value) ? value : {}
  const messages = list(record.messages).map((m) => ({
    id: String(m.id ?? ''),
    from: String(m.from ?? ''),
    ...(typeof m.fromName === 'string' ? { fromName: m.fromName } : {}),
    text: typeof m.text === 'string' ? m.text : '',
  }))
  return {
    text: busInboxText(messages),
    lease: typeof record.lease === 'string' ? record.lease : undefined,
  }
}

async function takeAndAck(call: Call, taken: unknown): Promise<string> {
  const { text, lease } = handed(taken)
  if (lease) await call('bus.ack', { lease })
  return text
}

async function managed(call: Call, facts: Facts): Promise<unknown> {
  const [processes, panes] = await Promise.all([call('process.list', {}), call('pane.list', {})])
  const byPane = new Map(list(panes).map((p) => [p.paneId, p]))
  const owned = list(processes).filter(
    (p) =>
      p.status !== 'closed' &&
      typeof p.paneId === 'string' &&
      facts.ownsChild(facts.paneId, p.paneId),
  )
  return {
    managed: owned.map((p) => {
      const pane = byPane.get(p.paneId)
      return {
        paneId: p.paneId,
        name: p.name,
        status: p.status,
        startedAt: p.startedAt,
        ...(p.splitTab ? { tab: p.splitTab } : {}),
        ...(pane
          ? {
              workspaceId: pane.workspaceId,
              title: pane.title,
              agent: pane.agent,
              agentState: pane.agentState,
              hibernated: pane.hibernated,
            }
          : { closed: true }),
      }
    }),
  }
}

function wrapped(paneId: unknown, text: unknown): string {
  return otherPaneText(String(paneId ?? ''), typeof text === 'string' ? text : '')
}

function paneRead(value: unknown): unknown {
  if (!isRecord(value)) return value
  return { ...value, text: wrapped(value.paneId, value.text) }
}

function paneWait(value: unknown): unknown {
  if (!isRecord(value) || typeof value.message !== 'string') return value
  return { ...value, message: wrapped(value.paneId, value.message) }
}

function names(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

const SECOND_MS = 1000

export const AGENT_CORE_TOOLS: Readonly<Record<AgentCoreToolName, CoreTool>> = {
  ostia_workspaces: { methods: ['workspace.list'], run: (_i, call) => call('workspace.list', {}) },
  ostia_panes: { methods: ['pane.list'], run: (_i, call) => call('pane.list', {}) },
  ostia_managed: {
    methods: ['process.list', 'pane.list'],
    run: (_i, call, facts) => managed(call, facts),
  },
  ostia_skill: {
    methods: [],
    run: async (input, _call, facts) => {
      const { name = '', file } = strings(input, ['name', 'file'])
      const read = readPlaybook(parsePlaybooks(facts.playbookSettings()), name, file)
      if (!read.ok) throw new Error(read.error)
      return read.text
    },
  },
  ostia_agent_run: {
    methods: ['agent.run'],
    run: (input, call) =>
      call('agent.run', strings(input, ['agent', 'prompt', 'model', 'workspace', 'name'])),
  },
  ostia_bus_send: {
    methods: ['bus.send', 'bus.ack'],
    run: async (input, call) => {
      const seconds = typeof input.waitSeconds === 'number' ? input.waitSeconds : undefined
      const sent = await call('bus.send', {
        ...strings(input, ['to', 'text']),
        ...(seconds !== undefined && seconds > 0 ? { waitMs: seconds * SECOND_MS } : {}),
      })
      const reply = isRecord(sent) ? sent.reply : undefined
      if (!isRecord(sent) || !isRecord(reply)) return sent
      const { reply: _reply, ...receipt } = sent
      return { ...receipt, reply: await takeAndAck(call, reply) }
    },
  },
  ostia_bus_inbox: {
    methods: ['bus.inbox', 'bus.ack'],
    run: async (_input, call) => takeAndAck(call, await call('bus.inbox', { take: true })),
  },
  ostia_pane_read: {
    methods: ['pane.read'],
    run: async (input, call) =>
      paneRead(
        await call('pane.read', {
          ...strings(input, ['pane']),
          ...(typeof input.lines === 'number' ? { lines: input.lines } : {}),
        }),
      ),
  },
  ostia_pane_wait: {
    methods: ['pane.wait'],
    run: async (input, call) =>
      paneWait(
        await call('pane.wait', {
          panes: names(input.panes),
          ...(names(input.until).length > 0 ? { until: names(input.until) } : {}),
          ...(typeof input.timeoutSeconds === 'number'
            ? { timeoutMs: input.timeoutSeconds * SECOND_MS }
            : {}),
        }),
      ),
  },
}

function outputOf(result: unknown): string {
  return typeof result === 'string' ? result : JSON.stringify(result ?? null)
}

function reachable(
  identity: PaneIdentity | undefined,
  scope: CoreScope,
  isManagerSession: AgentCoreDeps['isManagerSession'],
): identity is PaneIdentity {
  return (
    identity?.kind === 'pane' &&
    (identity.manager !== true || isManagerSession(identity.paneId)) &&
    identity.windowId === scope.windowId &&
    identity.workspaceId === scope.workspaceId
  )
}

type CoreContext = { ok: true; ctx: ControlMethodContext } | { ok: false; reply: AgentToolReply }

export function coreContext(
  deps: Pick<AgentCoreDeps, 'identityOf' | 'sandboxed' | 'isManagerSession'>,
  scope: CoreScope,
  lifecycle: CoreLifecycle,
): CoreContext {
  const identity = deps.identityOf(scope.paneId)
  if (!reachable(identity, scope, deps.isManagerSession)) return { ok: false, reply: REFUSED }
  if (deps.sandboxed(scope.workspaceId)) return { ok: false, reply: SANDBOXED }
  initCaps(identity.externalId)
  return {
    ok: true,
    ctx: {
      identity,
      authed: {
        externalId: identity.externalId,
        paneId: identity.paneId,
        workspaceId: identity.workspaceId,
      },
      conn: lifecycle.conn,
      token: lifecycle.token,
    },
  }
}

export function createAgentCoreCall(deps: AgentCoreDeps) {
  return async ({ scope, name, input, lifecycle }: CoreCallRequest): Promise<AgentToolReply> => {
    if (!isAgentCoreTool(name)) return BAD_TOOL
    const resolved = coreContext(deps, scope, lifecycle)
    if (!resolved.ok) return resolved.reply
    const { ctx } = resolved
    const tool = AGENT_CORE_TOOLS[name]
    const call: Call = (method, params) => {
      if (!tool.methods.includes(method)) {
        return Promise.reject(new Error(`${name} cannot call ${method}`))
      }
      return deps.call(method, params, ctx)
    }
    try {
      const result = await tool.run(input, call, {
        paneId: ctx.identity.paneId,
        ownsChild: deps.ownsChild,
        playbookSettings: deps.playbookSettings,
      })
      return { ok: true, output: outputOf(result) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
}
