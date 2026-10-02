import { COMMAND_ID_PATTERN, EXTENSION_ID_PATTERN } from '../main/extensionManifest'
import {
  AGENT_HOOK_INPUT_MAX,
  type AgentHookEvent,
  type HookAgent,
  agentHookOutput,
  isAgentHookEvent,
  isHookAgent,
} from '../shared/agentPlugins'

export interface AgentHookCall {
  extId: string
  command: string
  agent: HookAgent
  event: AgentHookEvent
}

export const AGENT_HOOK_USAGE =
  'usage: pine agent-hook <extId> <command> <claude|codex> <event>   (stdin: the hook JSON)'

export function parseAgentHookArgs(args: readonly string[]): AgentHookCall | null {
  const [extId, command, agent, event, ...rest] = args
  if (rest.length > 0 || !extId || !command) return null
  if (!EXTENSION_ID_PATTERN.test(extId) || !COMMAND_ID_PATTERN.test(command)) return null
  if (!isHookAgent(agent) || !isAgentHookEvent(event)) return null
  return { extId, command, agent, event }
}

type InvokeResult =
  | { ok: true; text?: string; data?: unknown }
  | { ok: false; error: string; message?: string }

export interface AgentHookIo {
  readInput: () => Promise<string>
  invoke: (params: {
    extId: string
    command: string
    args: { argv: string[]; stdin: string }
  }) => Promise<InvokeResult>
  out: (line: string) => void
  err: (line: string) => void
}

export async function runAgentHook(args: readonly string[], io: AgentHookIo): Promise<number> {
  const call = parseAgentHookArgs(args)
  if (!call) {
    io.err(AGENT_HOOK_USAGE)
    return 1
  }
  const input = await io.readInput()
  if (Buffer.byteLength(input) > AGENT_HOOK_INPUT_MAX) {
    io.err(`pine agent-hook: hook input is larger than ${AGENT_HOOK_INPUT_MAX} bytes`)
    return 1
  }
  const res = await io.invoke({
    extId: call.extId,
    command: call.command,
    args: { argv: [call.agent, call.event], stdin: input },
  })
  if (!res.ok) {
    io.err(`pine agent-hook: ${call.extId} ${call.command} failed (${res.error})`)
    return 1
  }
  const output = agentHookOutput(call.event, res.text)
  if (output) io.out(output)
  return 0
}
