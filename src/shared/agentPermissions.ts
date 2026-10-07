import {
  QUESTION_CONTEXT_MAX,
  QUESTION_MAX,
  type QuestionContent,
  clipTo,
  oneLine,
  plainBlock,
} from './questions'

export const PERMISSION_AGENTS = ['claude', 'codex'] as const
export type PermissionAgent = (typeof PERMISSION_AGENTS)[number]

export const PERMISSION_CHOICES = ['once', 'always', 'deny'] as const
export type PermissionChoice = (typeof PERMISSION_CHOICES)[number]

export const PERMISSION_WAIT_MS = 300_000
export const PERMISSION_TOOL_MAX = 120
export const PERMISSION_HOOK_INPUT_MAX = 1024 * 1024

export interface PermissionInfo {
  agent: PermissionAgent
  tool: string
}

export interface PermissionRequestPayload {
  tool: string
  toolInput: unknown
  suggestions: unknown[]
}

export interface PermissionAskParams {
  agent: PermissionAgent
  tool: string
  detail: string
  always: boolean
}

export function isPermissionAgent(value: unknown): value is PermissionAgent {
  return PERMISSION_AGENTS.includes(value as PermissionAgent)
}

export function parsePermissionPayload(raw: string): PermissionRequestPayload | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const payload = parsed as Record<string, unknown>
  if (typeof payload.tool_name !== 'string') return null
  const tool = oneLine(payload.tool_name)
  if (!tool) return null
  const suggestions = Array.isArray(payload.permission_suggestions)
    ? payload.permission_suggestions
    : []
  return { tool, toolInput: payload.tool_input, suggestions }
}

function stringField(input: Record<string, unknown>, key: string): string | null {
  const value = input[key]
  return typeof value === 'string' && value !== '' ? value : null
}

function editDetail(input: Record<string, unknown>, path: string): string {
  const before = stringField(input, 'old_string')
  const after = stringField(input, 'new_string') ?? stringField(input, 'content')
  const lines = [path]
  if (before !== null) lines.push(...before.split('\n').map((line) => `- ${line}`))
  if (after !== null) lines.push(...after.split('\n').map((line) => `+ ${line}`))
  return lines.join('\n')
}

function rawDetail(toolInput: unknown): string {
  if (typeof toolInput === 'string') return toolInput
  try {
    return JSON.stringify(toolInput, null, 2) ?? ''
  } catch {
    return ''
  }
}

export function permissionDetail(toolInput: unknown): string {
  if (typeof toolInput === 'object' && toolInput !== null && !Array.isArray(toolInput)) {
    const input = toolInput as Record<string, unknown>
    const command = stringField(input, 'command')
    if (command !== null) return command
    const path = stringField(input, 'file_path') ?? stringField(input, 'path')
    if (path !== null) return editDetail(input, path)
  }
  return rawDetail(toolInput)
}

export function permissionAskParams(
  agent: PermissionAgent,
  payload: PermissionRequestPayload,
): PermissionAskParams {
  return {
    agent,
    tool: payload.tool,
    detail: permissionDetail(payload.toolInput),
    always: agent === 'claude' && payload.suggestions.length > 0,
  }
}

export function permissionChoices(always: boolean): PermissionChoice[] {
  return always ? ['once', 'always', 'deny'] : ['once', 'deny']
}

export function normalizePermissionAsk(
  raw: unknown,
): { content: QuestionContent; permission: PermissionInfo } | null {
  if (typeof raw !== 'object' || raw === null) return null
  const params = raw as Record<string, unknown>
  if (!isPermissionAgent(params.agent)) return null
  if (typeof params.tool !== 'string' || typeof params.detail !== 'string') return null
  const tool = clipTo(oneLine(params.tool), PERMISSION_TOOL_MAX)
  if (!tool) return null
  const detail = clipTo(plainBlock(params.detail), QUESTION_CONTEXT_MAX)
  const subject = oneLine(detail.split('\n')[0] ?? '')
  return {
    content: {
      question: clipTo(subject ? `${tool}: ${subject}` : tool, QUESTION_MAX),
      context: detail,
      choices: permissionChoices(params.always === true),
      mode: 'single',
      timeoutMs: PERMISSION_WAIT_MS,
    },
    permission: { agent: params.agent, tool },
  }
}

export function permissionHookOutput(
  decision: PermissionChoice | null,
  suggestions: readonly unknown[],
): string {
  if (decision === null) return ''
  const allowed = decision !== 'deny'
  const always = decision === 'always' && suggestions.length > 0
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: allowed
        ? { behavior: 'allow', ...(always ? { updatedPermissions: suggestions } : {}) }
        : { behavior: 'deny', message: 'The human denied this permission.' },
    },
  })
}
