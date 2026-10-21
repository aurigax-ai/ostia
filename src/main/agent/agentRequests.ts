import { isAbsolute } from 'node:path'
import {
  AGENT_COMPLETE_INPUT_MAX,
  AGENT_COMPLETE_SYSTEM_MAX,
  AGENT_PROMPT_MAX,
  AGENT_SESSION_ID_PATTERN,
  AGENT_TOOL_DESCRIPTION_MAX,
  AGENT_TOOL_NAME_PATTERN,
  AGENT_TOOL_SCHEMA_MAX,
  AGENT_TOOLS_MAX,
  type AgentModelRef,
  type AgentToolSpec,
} from '@aurigax-ai/ostia-extension-sdk/contract/agent'
import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'

export interface AgentOpenInput {
  sessionId: string
  workspaceId: string
  cwd: string
  tools: AgentToolSpec[]
  rules: boolean
  model?: AgentModelRef
}

export function sessionIdOf(raw: unknown): string | null {
  return typeof raw === 'string' && AGENT_SESSION_ID_PATTERN.test(raw) ? raw : null
}

function modelRefOf(raw: unknown): AgentModelRef | undefined {
  if (!isRecord(raw) || typeof raw.provider !== 'string' || typeof raw.model !== 'string') {
    return undefined
  }
  return raw.provider && raw.model ? { provider: raw.provider, model: raw.model } : undefined
}

function schemaOf(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw) || raw.type !== 'object') return null
  return JSON.stringify(raw).length <= AGENT_TOOL_SCHEMA_MAX ? raw : null
}

function toolSpecsOf(raw: unknown): AgentToolSpec[] {
  if (!Array.isArray(raw)) return []
  const specs: AgentToolSpec[] = []
  for (const item of raw) {
    if (specs.length === AGENT_TOOLS_MAX) break
    if (!isRecord(item) || typeof item.name !== 'string') continue
    if (!AGENT_TOOL_NAME_PATTERN.test(item.name) || specs.some((s) => s.name === item.name))
      continue
    const description =
      typeof item.description === 'string'
        ? item.description.slice(0, AGENT_TOOL_DESCRIPTION_MAX).trim()
        : ''
    const inputSchema = schemaOf(item.inputSchema)
    if (description && inputSchema) specs.push({ name: item.name, description, inputSchema })
  }
  return specs
}

export function openInputOf(sessionId: unknown, raw: unknown): AgentOpenInput | null {
  const id = sessionIdOf(sessionId)
  if (!id || !isRecord(raw)) return null
  if (typeof raw.workspaceId !== 'string' || !raw.workspaceId) return null
  if (typeof raw.cwd !== 'string' || !isAbsolute(raw.cwd)) return null
  const model = modelRefOf(raw.model)
  return {
    sessionId: id,
    workspaceId: raw.workspaceId,
    cwd: raw.cwd,
    tools: toolSpecsOf(raw.tools),
    rules: raw.rules !== false,
    ...(model ? { model } : {}),
  }
}

export function promptOf(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length > 0 && raw.length <= AGENT_PROMPT_MAX ? raw : null
}

export function completeOf(raw: unknown): { system: string; input: string } | null {
  if (!isRecord(raw) || typeof raw.system !== 'string' || typeof raw.input !== 'string') return null
  const { system, input } = raw
  if (!system || !input) return null
  if (system.length > AGENT_COMPLETE_SYSTEM_MAX || input.length > AGENT_COMPLETE_INPUT_MAX) {
    return null
  }
  return { system, input }
}
