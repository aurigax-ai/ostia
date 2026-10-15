import { quoteArg } from '../terminal/shellQuote'
import { resumeFlags, safeEnv } from './agentLaunch'

export type ResumableAgent = 'claude' | 'codex'

export interface AgentResume {
  agent: ResumableAgent
  id: string
  cwd?: string
  args?: string[]
  env?: Record<string, string>
}

export interface ResumeFailure {
  resume: AgentResume
  exitCode: number
}

export function parseResumeFailure(raw: unknown): ResumeFailure | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { resume, exitCode } = raw as Record<string, unknown>
  const parsed = parseAgentResume(resume)
  return parsed &&
    Number.isInteger(exitCode) &&
    (exitCode as number) > 0 &&
    (exitCode as number) < 256
    ? { resume: parsed, exitCode: exitCode as number }
    : null
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

function resumeArgs(agent: ResumableAgent, raw: unknown): string[] {
  if (!Array.isArray(raw) || !raw.every((arg) => typeof arg === 'string')) return []
  return resumeFlags(agent, raw)
}

export function parseAgentResume(raw: unknown): AgentResume | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { agent, id, cwd, args, env } = raw as Record<string, unknown>
  if (!isResumableAgent(agent) || typeof id !== 'string' || !RESUME_ID.test(id)) return null
  const resume: AgentResume = { agent, id }
  if (isResumeCwd(cwd)) resume.cwd = cwd
  const flags = resumeArgs(agent, args)
  if (flags.length > 0) resume.args = flags
  const vars = safeEnv(env)
  if (Object.keys(vars).length > 0) resume.env = vars
  return resume
}

export function sameResume(a: AgentResume | undefined, b: AgentResume): boolean {
  return (
    a?.agent === b.agent &&
    a.id === b.id &&
    a.cwd === b.cwd &&
    JSON.stringify(a.args ?? []) === JSON.stringify(b.args ?? []) &&
    JSON.stringify(a.env ?? {}) === JSON.stringify(b.env ?? {})
  )
}

function agentCommandLine(resume: AgentResume, words: string[]): string {
  const env = Object.entries(resume.env ?? {}).map(([name, value]) => `${name}=${quoteArg(value)}`)
  return [...env, `'${resume.agent}'`, ...words, ...(resume.args ?? []).map(quoteArg)].join(' ')
}

export function resumeCommand(resume: AgentResume): string {
  return agentCommandLine(
    resume,
    resume.agent === 'claude' ? ['--resume', resume.id] : ['resume', resume.id],
  )
}

export function forkCommand(resume: AgentResume): string {
  return agentCommandLine(
    resume,
    resume.agent === 'claude' ? ['--resume', resume.id, '--fork-session'] : ['fork', resume.id],
  )
}

export function newSessionCommand(agent: ResumableAgent): string {
  return `'${agent}'`
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
