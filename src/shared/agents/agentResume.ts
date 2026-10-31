import { hasControlCharacter } from '../common/hiddenText'
import { quoteArg } from '../terminal/shellQuote'
import { resumeFlags, type TypedLaunch, typedLaunchOf } from './agentLaunch'

export type ResumableAgent = 'claude' | 'codex' | 'agy'

export interface AgentResume {
  agent: ResumableAgent
  id: string
  cwd?: string
  args?: string[]
  typed?: TypedLaunch
}

export interface ResumeFailure {
  resume: AgentResume
  exitCode: number
}

export function parseResumeFailure(raw: unknown): ResumeFailure | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { resume, exitCode } = raw as Record<string, unknown>
  const parsed = parseStoredResume(resume)
  return parsed &&
    Number.isInteger(exitCode) &&
    (exitCode as number) > 0 &&
    (exitCode as number) < 256
    ? { resume: parsed, exitCode: exitCode as number }
    : null
}

export const RESUMABLE_AGENTS: readonly ResumableAgent[] = ['claude', 'codex', 'agy']

export function canFork(agent: ResumableAgent): boolean {
  return agent !== 'agy'
}

const RESUME_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

const RESUME_CWD_MAX = 4096

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
  const { agent, id, cwd, args } = raw as Record<string, unknown>
  if (!isResumableAgent(agent) || typeof id !== 'string' || !RESUME_ID.test(id)) return null
  const resume: AgentResume = { agent, id }
  if (isResumeCwd(cwd)) resume.cwd = cwd
  const flags = resumeArgs(agent, args)
  if (flags.length > 0) resume.args = flags
  return resume
}

export function parseStoredResume(raw: unknown): AgentResume | null {
  const resume = parseAgentResume(raw)
  if (!resume) return null
  const typed = typedLaunchOf(resume.agent, (raw as Record<string, unknown>).typed)
  return typed ? { ...resume, typed } : resume
}

export function sameResume(a: AgentResume | undefined, b: AgentResume): boolean {
  return (
    a?.agent === b.agent &&
    a.id === b.id &&
    a.cwd === b.cwd &&
    JSON.stringify(a.args ?? []) === JSON.stringify(b.args ?? []) &&
    JSON.stringify(a.typed ?? {}) === JSON.stringify(b.typed ?? {})
  )
}

function agentCommandLine(resume: AgentResume, words: string[]): string {
  const typed = typedLaunchOf(resume.agent, resume.typed)
  return [
    ...Object.entries(typed?.env ?? {}).map(([name, value]) => `${name}=${quoteArg(value)}`),
    `'${resume.agent}'`,
    ...words,
    ...resumeArgs(resume.agent, resume.args).map(quoteArg),
    ...(typed?.args ?? []).map(quoteArg),
  ].join(' ')
}

const RESUME_WORDS: Record<ResumableAgent, (id: string) => string[]> = {
  claude: (id) => ['--resume', id],
  codex: (id) => ['resume', id],
  agy: (id) => ['--conversation', id],
}

export function resumeCommand(resume: AgentResume): string {
  return agentCommandLine(resume, RESUME_WORDS[resume.agent](resume.id))
}

export function forkCommand(resume: AgentResume): string {
  if (!canFork(resume.agent)) throw new Error(`${resume.agent} cannot fork`)
  return agentCommandLine(
    resume,
    resume.agent === 'claude' ? ['--resume', resume.id, '--fork-session'] : ['fork', resume.id],
  )
}

export function newSessionCommand(agent: ResumableAgent): string {
  return `'${agent}'`
}

export function resumeFromHookPayload(payload: string): string | null {
  const text = payload.trim()
  if (!text.startsWith('{')) return RESUME_ID.test(text) ? text : null
  try {
    const payload = JSON.parse(text) as Record<string, unknown>
    const id = payload.session_id ?? payload.conversationId
    return typeof id === 'string' && RESUME_ID.test(id) ? id : null
  } catch {
    return null
  }
}
