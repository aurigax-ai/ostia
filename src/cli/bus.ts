import {
  AGENT_HOOK_CONTEXT_EVENTS,
  type AgentHookEvent,
  agentHookOutput,
} from '../shared/agentPlugins'
import type { BusDelivery } from '../shared/busMessages'

export const BUS_HOOK_USAGE = `usage: ostia bus hook <${AGENT_HOOK_CONTEXT_EVENTS.join('|')}>`

function isContextEvent(value: unknown): value is AgentHookEvent {
  return AGENT_HOOK_CONTEXT_EVENTS.includes(value as AgentHookEvent)
}

export const BUS_QUEUED_HINT =
  'queued: the receiver reads it at its next prompt, or the human presses Enter in that pane (ostia bus sent shows when it was seen)'

export const BUS_ASLEEP_HINT =
  'asleep: the receiver is hibernated; wake it with ostia pane wake <pane> so its agent reads the message'

export function busWaitTimeoutMs(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const seconds = Number(raw)
  if (raw.trim() === '' || !Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`--timeout expects seconds, got '${raw}'`)
  }
  return Math.round(seconds * 1000)
}

export interface BusSendOk {
  ok: true
  id?: string
  delivered?: BusDelivery
  asleep?: true
}

export interface SentMessage {
  id: string
  to: string
  preview: string
  ts: string
  seenAt?: string
}

export interface BusHookIo {
  context: () => Promise<{ text?: string | null }>
  out: (line: string) => void
  err: (line: string) => void
}

export async function runBusHook(args: readonly string[], io: BusHookIo): Promise<number> {
  const [event, ...rest] = args
  if (rest.length > 0 || !isContextEvent(event)) {
    io.err(BUS_HOOK_USAGE)
    return 1
  }
  try {
    const res = await io.context()
    const output = agentHookOutput(event, res.text ?? undefined)
    if (output) io.out(output)
  } catch {
    return 0
  }
  return 0
}

export function sentLine(message: SentMessage): string {
  const state = message.seenAt ? `seen ${message.seenAt}` : 'unseen'
  return [message.ts, message.to, state, message.preview].join('\t')
}

export function sentLines(messages: readonly SentMessage[]): string[] {
  return messages.length === 0 ? ['(no messages sent)'] : messages.map(sentLine)
}
