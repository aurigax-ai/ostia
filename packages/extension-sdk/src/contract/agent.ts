export const AGENT_EXTENSION_ID = 'agent'

export const AGENT_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export const AGENT_PROMPT_MAX = 200_000

export const AGENT_TOOLS_MAX = 64

export const AGENT_TOOL_OUTPUT_MAX = 200_000

export const AGENT_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export const AGENT_TOOL_DESCRIPTION_MAX = 8000

export const AGENT_TOOL_SCHEMA_MAX = 16_384

export const AGENT_TOOL_CALL_ID_MAX = 200

export const AGENT_PROVIDER_MODELS_MAX = 64

export interface AgentToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface AgentProviderEntry {
  id: string
  name: string
  baseUrl: string
  models: string[]
}

export interface AgentModelRef {
  provider: string
  model: string
}

export interface AgentOpenRequest {
  op: 'open'
  sessionId: string
  cwd: string
  tools: AgentToolSpec[]
  providers: AgentProviderEntry[]
  skillFolders: string[]
  model?: AgentModelRef
}

export interface AgentPromptRequest {
  op: 'prompt'
  sessionId: string
  text: string
  model?: AgentModelRef
}

export interface AgentSessionRequest {
  op: 'abort' | 'close'
  sessionId: string
}

export type AgentRequest = AgentOpenRequest | AgentPromptRequest | AgentSessionRequest

export type AgentReply =
  | { ok: true; model?: AgentModelRef; history?: AgentHistoryEntry[] }
  | { ok: false; error: string; message?: string }

export interface AgentHistoryEntry {
  role: 'user' | 'assistant'
  text: string
}

export type AgentEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; toolCallId: string; name: string; input: Record<string, unknown> }
  | { type: 'tool-done'; toolCallId: string; isError: boolean }
  | { type: 'turn-end' }
  | { type: 'error'; message: string }

export interface AgentEventNotice {
  sessionId: string
  event: AgentEvent
}

export interface AgentToolCall {
  sessionId: string
  toolCallId: string
  name: string
  input: Record<string, unknown>
}

export type AgentToolReply =
  | { ok: true; output: string }
  | { ok: false; error: string; denied?: true }
