import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentEvent,
  AgentOpenRequest,
  AgentReply,
  AgentRequest,
  AgentToolCall,
  AgentToolReply,
  AgentToolSpec,
} from '@aurigax-ai/ostia-extension-sdk/contract/agent'
import { type FakeAnswer, type FakeProvider, startFakeProvider } from '../e2e/fakeProvider'
import { createAgentHost } from '../src/extensions/agent/agentHost'

export const READ_FILE_TOOL: AgentToolSpec = {
  name: 'read_file',
  description: 'Read a file in the workspace.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
}

type ToolCaller = (call: AgentToolCall, signal: AbortSignal) => Promise<AgentToolReply>

export interface AgentRig {
  provider: FakeProvider
  dataDir: string
  cwd: string
  events: AgentEvent[]
  toolCalls: AgentToolCall[]
  setToolReply: (reply: (call: AgentToolCall) => AgentToolReply) => void
  setToolCaller: (caller: ToolCaller) => void
  handle: (request: AgentRequest) => Promise<AgentReply>
  listen: (listener: (sessionId: string, event: AgentEvent) => void) => void
  open: (sessionId: string, tools?: AgentToolSpec[]) => Promise<AgentReply>
  prompt: (sessionId: string, text: string) => Promise<AgentReply>
  settled: () => Promise<void>
  close: () => void
}

export async function startAgentRig(answer: FakeAnswer, again?: AgentRig): Promise<AgentRig> {
  const fake = again?.provider ?? (await startFakeProvider(answer))
  const root = mkdtempSync(join(tmpdir(), 'agent-rig-'))
  const data = again?.dataDir ?? join(root, 'data')
  const cwd = again?.cwd ?? join(root, 'work')
  mkdirSync(cwd, { recursive: true })
  const events: AgentEvent[] = []
  const toolCalls: AgentToolCall[] = []
  let caller: ToolCaller = async () => ({ ok: true, output: 'file body' })
  let listener: (sessionId: string, event: AgentEvent) => void = () => undefined
  let waiting: (() => void)[] = []
  const callTool: ToolCaller = async (call, signal) => {
    toolCalls.push(call)
    return caller(call, signal)
  }
  const host = createAgentHost({
    dataDir: data,
    callTool,
    emit: (sessionId, event) => {
      events.push(event)
      listener(sessionId, event)
      if (event.type !== 'turn-end') return
      for (const resolve of waiting) resolve()
      waiting = []
    },
  })
  const request = (sessionId: string, tools: AgentToolSpec[]): AgentOpenRequest => ({
    op: 'open',
    sessionId,
    cwd,
    tools,
    providers: [{ id: 'fake', name: 'Fake', baseUrl: fake.url, models: ['fake-model'] }],
    skillFolders: [],
  })
  return {
    provider: fake,
    dataDir: data,
    cwd,
    events,
    toolCalls,
    setToolReply: (next) => {
      caller = async (call) => next(call)
    },
    setToolCaller: (next) => {
      caller = next
    },
    handle: (request) => host.handle(request),
    listen: (next) => {
      listener = next
    },
    open: (sessionId, tools = [READ_FILE_TOOL]) => host.handle(request(sessionId, tools)),
    prompt: (sessionId, text) => host.handle({ op: 'prompt', sessionId, text }),
    settled: () => new Promise((resolve) => waiting.push(resolve)),
    close: () => {
      host.closeAll()
      fake.close()
    },
  }
}
