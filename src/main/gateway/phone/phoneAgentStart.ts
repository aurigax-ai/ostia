import { plainBlock } from '../../../shared/agents/questions'
import { phoneAgentCommand } from '../../panes/phoneAgent'
import type { GatewayControlDeps, RpcOutcome } from '../controlDispatch'

const AGENT_START_PROMPT_MAX = 4000
const AGENT_STARTS_PER_MINUTE = 3
const MINUTE_MS = 60_000
const PHONE_WORKSPACE_KINDS: ReadonlySet<string> = new Set(['agent', 'terminal'])
const agentStarts = new Map<string, number[]>()

function startAllowed(deviceId: string): boolean {
  const now = Date.now()
  const recent = (agentStarts.get(deviceId) ?? []).filter((at) => now - at < MINUTE_MS)
  if (recent.length >= AGENT_STARTS_PER_MINUTE) {
    agentStarts.set(deviceId, recent)
    return false
  }
  agentStarts.set(deviceId, [...recent, now])
  return true
}

function invalidParams(message: string): RpcOutcome {
  return { ok: false, code: -32602, message }
}

export async function agentStart(
  p: Record<string, unknown>,
  deviceId: string,
  deps: GatewayControlDeps,
): Promise<RpcOutcome> {
  if (p.sessionId !== undefined && (typeof p.sessionId !== 'string' || !p.sessionId)) {
    return invalidParams('unknown-session')
  }
  if (p.agent !== undefined && p.agent !== 'claude' && p.agent !== 'codex') {
    return invalidParams('bad-params')
  }
  const agent = p.agent ?? deps.phoneDefaults().agent
  const prompt = typeof p.prompt === 'string' ? plainBlock(p.prompt) : ''
  if (prompt.length > AGENT_START_PROMPT_MAX || !phoneAgentCommand(agent, prompt)) {
    return invalidParams('bad-params')
  }
  if (!startAllowed(deviceId)) return { ok: false, code: -32007, message: 'rate-limited' }
  const sessionId = p.sessionId ?? (await deps.phoneWorkspace())
  if (!sessionId) return invalidParams('phone-workspace-unavailable')
  const workspace = (await deps.listWorkspaces()).find((w) => w.workspaceId === sessionId)
  if (!workspace) return invalidParams('unknown-session')
  if (!PHONE_WORKSPACE_KINDS.has(workspace.kind)) return invalidParams('refused')
  const started = await deps.startAgent(workspace.workspaceId, agent, prompt)
  if (!started?.started) {
    return {
      ok: false,
      code: -32006,
      message: 'not-started',
      ...(started ? { data: { paneId: started.paneId } } : {}),
    }
  }
  return { ok: true, result: { paneId: started.paneId, confirmed: started.confirmed } }
}
