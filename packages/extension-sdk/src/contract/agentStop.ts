import { AGENT_HOOK_INPUT_MAX, type HookAgent } from './agentPlugins'

export interface AgentStop {
  sessionId: string
  turnId?: string
  message?: string
  backgroundWork: boolean
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function idOf(value: unknown): string | undefined {
  return typeof value === 'string' && ID_PATTERN.test(value) ? value : undefined
}

function nonEmptyList(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0
}

export function parseAgentStop(_agent: HookAgent, input: string): AgentStop | null {
  if (Buffer.byteLength(input) > AGENT_HOOK_INPUT_MAX) return null
  let payload: unknown
  try {
    payload = JSON.parse(input)
  } catch {
    return null
  }
  if (!isRecord(payload)) return null
  const sessionId = idOf(payload.session_id)
  if (!sessionId) return null
  const stop: AgentStop = {
    sessionId,
    backgroundWork: nonEmptyList(payload.background_tasks) || nonEmptyList(payload.session_crons),
  }
  const turnId = idOf(payload.turn_id) ?? idOf(payload.prompt_id)
  if (turnId) stop.turnId = turnId
  const message = payload.last_assistant_message
  if (typeof message === 'string' && message.trim() !== '') stop.message = message
  return stop
}
