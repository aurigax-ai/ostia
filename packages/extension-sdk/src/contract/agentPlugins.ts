export const AGENT_PLUGIN_CAPABILITY = 'agent-plugin'

export const HOOK_AGENTS = ['claude', 'codex'] as const

export type HookAgent = (typeof HOOK_AGENTS)[number]

export const AGENT_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SessionEnd',
  'Notification',
] as const

export type AgentHookEvent = (typeof AGENT_HOOK_EVENTS)[number]

export const AGENT_HOOK_CONTEXT_EVENTS: readonly AgentHookEvent[] = [
  'SessionStart',
  'UserPromptSubmit',
]

const CLAUDE_ONLY_EVENTS: readonly AgentHookEvent[] = ['Notification']

export function hookAgentsFor(event: AgentHookEvent): HookAgent[] {
  return CLAUDE_ONLY_EVENTS.includes(event) ? ['claude'] : [...HOOK_AGENTS]
}

export function isHookAgent(value: unknown): value is HookAgent {
  return HOOK_AGENTS.includes(value as HookAgent)
}

export function isAgentHookEvent(value: unknown): value is AgentHookEvent {
  return AGENT_HOOK_EVENTS.includes(value as AgentHookEvent)
}

export interface AgentSkillContribution {
  name: string
  path: string
  files: string[]
}

export interface AgentHookContribution {
  event: AgentHookEvent
  command: string
}

export interface AgentHookSummary extends AgentHookContribution {
  agents: HookAgent[]
}

export const AGENT_SKILL_NAME_PATTERN = /^[a-z][a-z0-9-]{0,39}$/
export const AGENT_SKILL_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}\.(md|txt)$/
export const AGENT_SKILL_ENTRY = 'SKILL.md'
export const MAX_AGENT_SKILLS = 8
export const MAX_AGENT_SKILL_FILES = 16
export const MAX_AGENT_HOOKS = 16
export const AGENT_SKILL_FILE_MAX_BYTES = 256 * 1024
export const AGENT_SKILL_MAX_BYTES = 1024 * 1024
export const AGENT_SKILL_DESCRIPTION_MAX = 1024
export const AGENT_HOOK_INPUT_MAX = 1024 * 1024
export const AGENT_HOOK_CONTEXT_MAX = 10_000

export function agentSkillId(extId: string, name: string): string {
  return `${extId}-${name}`
}

export function agentHookOutput(event: AgentHookEvent, text: string | undefined): string | null {
  if (!AGENT_HOOK_CONTEXT_EVENTS.includes(event)) return null
  const context = (text ?? '').trim().slice(0, AGENT_HOOK_CONTEXT_MAX)
  if (!context) return null
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: context },
  })
}

const LINE_BREAKS = /\r\n|[\n\r\u0085\u2028\u2029]/
const INLINE_INJECTION = /[!\u01c3][`\u02cb\u02f4\u2035$]/
const FENCED_INJECTION = /(?:[`\u02cb\u02f4\u2035]{3,}|~{3,})[ \t]*[!\u01c3$]/

export function skillDirective(text: string): string | null {
  const lines = text.split(LINE_BREAKS)
  for (const [i, line] of lines.entries()) {
    const flat = line.normalize('NFKC')
    if (INLINE_INJECTION.test(flat) || FENCED_INJECTION.test(flat)) {
      return `line ${i + 1}: shell injection (!\` or a \`\`\`! block) is not allowed`
    }
  }
  return null
}
