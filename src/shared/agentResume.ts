export type ResumableAgent = 'claude' | 'codex'

export interface AgentResume {
  agent: ResumableAgent
  id: string
  cwd?: string
}

export const RESUMABLE_AGENTS: readonly ResumableAgent[] = ['claude', 'codex']

const RESUME_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

const RESUME_CWD_MAX = 4096

function hasControlCharacter(text: string): boolean {
  for (const ch of text) {
    const code = ch.charCodeAt(0)
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true
  }
  return false
}

export function isResumableAgent(value: unknown): value is ResumableAgent {
  return typeof value === 'string' && (RESUMABLE_AGENTS as readonly string[]).includes(value)
}

function isResumeCwd(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith('/') &&
    value.length <= RESUME_CWD_MAX &&
    !hasControlCharacter(value)
  )
}

export function parseAgentResume(raw: unknown): AgentResume | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { agent, id, cwd } = raw as { agent?: unknown; id?: unknown; cwd?: unknown }
  if (!isResumableAgent(agent) || typeof id !== 'string' || !RESUME_ID.test(id)) return null
  return isResumeCwd(cwd) ? { agent, id, cwd } : { agent, id }
}

export function resumeCommand(resume: AgentResume): string {
  return resume.agent === 'claude' ? `claude --resume ${resume.id}` : `codex resume ${resume.id}`
}

export function resumeFromHookPayload(payload: string): { id: string; cwd?: string } | null {
  const text = payload.trim()
  if (!text.startsWith('{')) return RESUME_ID.test(text) ? { id: text } : null
  try {
    const json = JSON.parse(text) as Record<string, unknown>
    const id = json.session_id
    if (typeof id !== 'string' || !RESUME_ID.test(id)) return null
    return isResumeCwd(json.cwd) ? { id, cwd: json.cwd } : { id }
  } catch {
    return null
  }
}
