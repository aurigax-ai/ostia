export const AGENT_BUSY_REASONS = [
  'subagent',
  'background-task',
  'scheduled-task',
  'child-process',
  'unknown',
] as const

export type AgentBusyReason = (typeof AGENT_BUSY_REASONS)[number]

export type HibernateOutcome = 'hibernated' | 'no-terminal' | AgentBusyReason

export const CLAUDE_WORK_EVENTS = ['SubagentStart', 'SubagentStop', 'Stop'] as const

export type ClaudeWorkEvent = (typeof CLAUDE_WORK_EVENTS)[number]

export interface AgentWorkReport {
  subagentStarted?: string
  subagentStopped?: string
  turnEnded?: true
  tasks?: number
  scheduled?: number
}

const UNNAMED_SUBAGENT = 'subagent'
const SUBAGENT_ID_MAX = 200
const COUNT_MAX = 10_000
const ENDED_TASK_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'killed',
  'stopped',
  'cancelled',
  'canceled',
])

export function isAgentBusyReason(value: unknown): value is AgentBusyReason {
  return typeof value === 'string' && (AGENT_BUSY_REASONS as readonly string[]).includes(value)
}

export function isClaudeWorkEvent(value: unknown): value is ClaudeWorkEvent {
  return typeof value === 'string' && (CLAUDE_WORK_EVENTS as readonly string[]).includes(value)
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function parsePayload(raw: string): Record<string, unknown> {
  try {
    return record(JSON.parse(raw))
  } catch {
    return {}
  }
}

function subagentId(value: unknown): string {
  return typeof value === 'string' && value ? value.slice(0, SUBAGENT_ID_MAX) : UNNAMED_SUBAGENT
}

function tasksInFlight(value: unknown, stopping: string | null): number | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((entry) => {
    const task = record(entry)
    if (stopping !== null && task.id === stopping) return false
    return !(typeof task.status === 'string' && ENDED_TASK_STATUSES.has(task.status))
  }).length
}

function registryCounts(
  payload: Record<string, unknown>,
  stopping: string | null,
): Pick<AgentWorkReport, 'tasks' | 'scheduled'> {
  const tasks = tasksInFlight(payload.background_tasks, stopping)
  const scheduled = Array.isArray(payload.session_crons) ? payload.session_crons.length : undefined
  return {
    ...(tasks === undefined ? {} : { tasks }),
    ...(scheduled === undefined ? {} : { scheduled }),
  }
}

export function claudeWorkReport(event: ClaudeWorkEvent, raw: string): AgentWorkReport {
  const payload = parsePayload(raw)
  switch (event) {
    case 'SubagentStart':
      return { subagentStarted: subagentId(payload.agent_id) }
    case 'SubagentStop': {
      const id = subagentId(payload.agent_id)
      return { subagentStopped: id, ...registryCounts(payload, id) }
    }
    case 'Stop':
      return { turnEnded: true, ...registryCounts(payload, null) }
  }
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? Math.min(value, COUNT_MAX)
    : undefined
}

export function normalizeWorkReport(raw: unknown): AgentWorkReport {
  const src = record(raw)
  const tasks = count(src.tasks)
  const scheduled = count(src.scheduled)
  return {
    ...(typeof src.subagentStarted === 'string'
      ? { subagentStarted: subagentId(src.subagentStarted) }
      : {}),
    ...(typeof src.subagentStopped === 'string'
      ? { subagentStopped: subagentId(src.subagentStopped) }
      : {}),
    ...(src.turnEnded === true ? { turnEnded: true as const } : {}),
    ...(tasks === undefined ? {} : { tasks }),
    ...(scheduled === undefined ? {} : { scheduled }),
  }
}
