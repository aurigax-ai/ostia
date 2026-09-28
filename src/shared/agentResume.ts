export type ResumableAgent = 'claude' | 'codex'

export interface AgentResume {
  agent: ResumableAgent
  id: string
}

export const RESUMABLE_AGENTS: readonly ResumableAgent[] = ['claude', 'codex']

const RESUME_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export function isResumableAgent(value: unknown): value is ResumableAgent {
  return typeof value === 'string' && (RESUMABLE_AGENTS as readonly string[]).includes(value)
}

export function parseAgentResume(raw: unknown): AgentResume | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { agent, id } = raw as { agent?: unknown; id?: unknown }
  if (!isResumableAgent(agent) || typeof id !== 'string' || !RESUME_ID.test(id)) return null
  return { agent, id }
}

export function resumeCommand(resume: AgentResume): string {
  return resume.agent === 'claude' ? `claude --resume ${resume.id}` : `codex resume ${resume.id}`
}

export function resumeIdFromHookPayload(payload: string): string | null {
  const text = payload.trim()
  if (!text.startsWith('{')) return RESUME_ID.test(text) ? text : null
  try {
    const json = JSON.parse(text) as Record<string, unknown>
    for (const key of ['session_id', 'thread-id', 'thread_id', 'session-id']) {
      const value = json[key]
      if (typeof value === 'string' && RESUME_ID.test(value)) return value
    }
  } catch {
    return null
  }
  return null
}
