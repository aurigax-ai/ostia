import {
  AGENT_HOOK_CONTEXT_EVENTS,
  type AgentHookEvent,
  agentHookOutput,
} from '@aurigax-ai/ostia-extension-sdk/contract/agentPlugins'
import type { MessageConnection } from 'vscode-jsonrpc/node'
import type { BusDelivery } from '../../shared/agents/busMessages'
import { parseArgs } from '../common/args'
import { type ErrResult, describeErrResult, failUsage } from '../common/failure'

export const BUS_HOOK_USAGE = `usage: ostia bus hook <${AGENT_HOOK_CONTEXT_EVENTS.join('|')}>`

function isContextEvent(value: unknown): value is AgentHookEvent {
  return AGENT_HOOK_CONTEXT_EVENTS.includes(value as AgentHookEvent)
}

const BUS_QUEUED_HINT =
  'queued: the receiver reads it at its next prompt, or the human presses Enter in that pane (ostia bus sent shows when it was seen)'

const BUS_ASLEEP_HINT =
  'asleep: the receiver is hibernated; wake it with ostia pane wake <pane> so its agent reads the message'

export function busWaitTimeoutMs(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const seconds = Number(raw)
  if (raw.trim() === '' || !Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`--timeout expects seconds, got '${raw}'`)
  }
  return Math.round(seconds * 1000)
}

interface BusSendOk {
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

function sentLine(message: SentMessage): string {
  const state = message.seenAt ? `seen ${message.seenAt}` : 'unseen'
  return [message.ts, message.to, state, message.preview].join('\t')
}

export function sentLines(messages: readonly SentMessage[]): string[] {
  return messages.length === 0 ? ['(no messages sent)'] : messages.map(sentLine)
}

interface BusOk {
  ok: true
  id?: string
}
interface BusSentResult {
  messages: SentMessage[]
}
interface BusMessage {
  id: string
  from: string
  to: string
  text: string
  ts: string
  seenAt?: string
}
interface BusInboxResult {
  messages: BusMessage[]
}
interface BusWaitResult {
  messages: BusMessage[]
  timedOut: boolean
}
interface BusHandoff {
  id: string
  from: string
  to: string
  task: string
  summary: string
  state: string
  context?: { artifacts?: string[]; workDir?: string }
  ts: string
  updatedAt: string
}
interface BusHandoffsResult {
  handoffs: BusHandoff[]
}

export async function runBusVerb(conn: MessageConnection): Promise<void> {
  const sub = process.argv[3]
  const rawArgs = process.argv.slice(4)

  if (sub === 'send') {
    const [to, text] = rawArgs
    if (!to || text === undefined) {
      console.error('ostia bus send: missing <toExternalId> "<msg>"')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<BusSendOk | ErrResult>('bus.send', { to, text })
    if (res.ok) {
      console.log(JSON.stringify(res))
      if (res.asleep) console.error(BUS_ASLEEP_HINT)
      else if (res.delivered === 'queued') console.error(BUS_QUEUED_HINT)
    } else {
      console.error(`ostia: bus send failed (${describeErrResult(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'inbox') {
    const { drain } = parseArgs(rawArgs, { booleans: { drain: '--drain' } }).booleans
    const res = await conn.sendRequest<BusInboxResult | ErrResult>('bus.inbox', { drain })
    if ('messages' in res) {
      console.log(JSON.stringify(res.messages))
    } else {
      console.error(`ostia: bus inbox failed (${describeErrResult(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'sent') {
    const res = await conn.sendRequest<BusSentResult | ErrResult>('bus.sent')
    if ('messages' in res) {
      if (rawArgs.includes('--json')) console.log(JSON.stringify(res.messages))
      else for (const line of sentLines(res.messages)) console.log(line)
    } else {
      console.error(`ostia: bus sent failed (${describeErrResult(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'hook') {
    process.exitCode = await runBusHook(rawArgs, {
      context: () => conn.sendRequest<{ text?: string | null }>('bus.context'),
      out: (line) => console.log(line),
      err: (line) => console.error(line),
    })
  } else if (sub === 'wait') {
    const { values } = parseArgs(rawArgs, { values: { timeout: '--timeout' } })
    const timeoutMs = busWaitTimeoutMs(values.timeout)
    const res = await conn.sendRequest<BusWaitResult | ErrResult>('bus.wait', { timeoutMs })
    if ('messages' in res) {
      console.log(JSON.stringify(res))
    } else {
      console.error(`ostia: bus wait failed (${describeErrResult(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'handoff') {
    const { values: flags, positional } = parseArgs(rawArgs, {
      values: { task: '--task', summary: '--summary' },
    })
    const to = positional[0]
    if (!to || !flags.task || !flags.summary) {
      console.error('ostia bus handoff: missing <to> --task "..." --summary "..."')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<BusSendOk | ErrResult>('bus.handoff', {
      to,
      task: flags.task,
      summary: flags.summary,
    })
    if (res.ok) {
      console.log(JSON.stringify(res))
      if (res.delivered === 'queued') console.error(BUS_QUEUED_HINT)
    } else {
      console.error(`ostia: bus handoff failed (${describeErrResult(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'claim') {
    const id = rawArgs[0]
    if (!id) {
      console.error('ostia bus claim: missing <id>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<BusOk | ErrResult>('bus.claim', { id })
    if (res.ok) {
      console.log('ok')
    } else {
      console.error(`ostia: bus claim failed (${describeErrResult(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'handoffs') {
    const { all } = parseArgs(rawArgs, { booleans: { all: '--all' } }).booleans
    const res = await conn.sendRequest<BusHandoffsResult | ErrResult>('bus.handoffs', { all })
    if ('handoffs' in res) {
      console.log(JSON.stringify(res.handoffs))
    } else {
      console.error(`ostia: bus handoffs failed (${describeErrResult(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'done') {
    const id = rawArgs[0]
    if (!id) {
      console.error('ostia bus done: missing <id>')
      process.exitCode = 1
      return
    }
    const res = await conn.sendRequest<BusOk | ErrResult>('bus.update', { id, state: 'completed' })
    if (res.ok) {
      console.log('ok')
    } else {
      console.error(`ostia: bus done failed (${describeErrResult(res)})`)
      process.exitCode = 1
    }
  } else {
    failUsage('bus')
  }
}
