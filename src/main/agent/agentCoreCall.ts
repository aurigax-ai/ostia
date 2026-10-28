import type { AgentToolReply } from '@aurigax-ai/ostia-extension-sdk/contract/agent'
import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import { CancellationTokenSource, Emitter } from 'vscode-jsonrpc/node'
import { type AgentCoreToolName, isAgentCoreTool } from '../../shared/agent/agentCoreTools'
import { busInboxText } from '../../shared/agents/busMessages'
import { initCaps } from '../approvals/capabilityStore'
import type { ControlConn, ControlMethodContext } from '../control/controlServer'
import type { PaneIdentity } from '../control/idRegistry'

interface CoreScope {
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
  call: (name: string, params: unknown, ctx: ControlMethodContext) => Promise<unknown>
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

const SECOND_MS = 1000

export const AGENT_CORE_TOOLS: Readonly<Record<AgentCoreToolName, CoreTool>> = {
  ostia_workspaces: { methods: ['workspace.list'], run: (_i, call) => call('workspace.list', {}) },
  ostia_panes: { methods: ['pane.list'], run: (_i, call) => call('pane.list', {}) },
  ostia_managed: {
    methods: ['process.list', 'pane.list'],
    run: (_i, call, facts) => managed(call, facts),
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
}

function outputOf(result: unknown): string {
  return typeof result === 'string' ? result : JSON.stringify(result ?? null)
}

function reachable(identity: PaneIdentity | undefined, scope: CoreScope): identity is PaneIdentity {
  return (
    identity?.kind === 'pane' &&
    identity.manager !== true &&
    identity.windowId === scope.windowId &&
    identity.workspaceId === scope.workspaceId
  )
}

export function createAgentCoreCall(deps: AgentCoreDeps) {
  return async ({ scope, name, input, lifecycle }: CoreCallRequest): Promise<AgentToolReply> => {
    if (!isAgentCoreTool(name)) return BAD_TOOL
    const identity = deps.identityOf(scope.paneId)
    if (!reachable(identity, scope)) return REFUSED
    if (deps.sandboxed(scope.workspaceId)) return SANDBOXED
    initCaps(identity.externalId)
    const ctx: ControlMethodContext = {
      identity,
      authed: {
        externalId: identity.externalId,
        paneId: identity.paneId,
        workspaceId: identity.workspaceId,
      },
      conn: lifecycle.conn,
      token: lifecycle.token,
    }
    const tool = AGENT_CORE_TOOLS[name]
    const call: Call = (method, params) => {
      if (!tool.methods.includes(method)) {
        return Promise.reject(new Error(`${name} cannot call ${method}`))
      }
      return deps.call(method, params, ctx)
    }
    try {
      const result = await tool.run(input, call, {
        paneId: identity.paneId,
        ownsChild: deps.ownsChild,
      })
      return { ok: true, output: outputOf(result) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
}
