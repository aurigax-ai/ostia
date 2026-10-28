import type {
  AgentEvent,
  AgentModelRef,
  AgentReply,
  AgentToolReply,
  AgentToolSpec,
} from '@aurigax-ai/ostia-extension-sdk/contract/agent'

interface AgentOpenOptions {
  workspaceId: string
  paneId: string
  cwd: string
  tools: AgentToolSpec[]
  model?: AgentModelRef
  rules?: boolean
}

export interface AgentToolCallNotice {
  callId: string
  sessionId: string
  toolCallId: string
  name: string
  input: Record<string, unknown>
}

export interface AgentSessionsApi {
  open: (sessionId: string, options: AgentOpenOptions) => Promise<AgentReply>
  prompt: (sessionId: string, text: string) => Promise<AgentReply>
  abort: (sessionId: string) => Promise<AgentReply>
  close: (sessionId: string) => Promise<AgentReply>
  answerTool: (callId: string, reply: AgentToolReply) => void
  coreCall: (sessionId: string, callId: string) => Promise<AgentToolReply>
  onEvent: (cb: (notice: { sessionId: string; event: AgentEvent }) => void) => () => void
  onToolCall: (cb: (notice: AgentToolCallNotice) => void) => () => void
  onToolCancel: (cb: (notice: { callId: string }) => void) => () => void
}
