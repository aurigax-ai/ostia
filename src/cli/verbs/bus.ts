import {
  AGENT_HOOK_CONTEXT_EVENTS,
  type AgentHookEvent,
  agentHookOutput,
} from '@aurigax-ai/ostia-extension-sdk/contract/agentPlugins'
import type { MessageConnection } from 'vscode-jsonrpc/node'
import { type MailPending, type MailReceipt, mailLabel } from '../../shared/agents/busMessages'
import { parseArgs } from '../common/args'
import { type ErrResult, describeErrResult, failUsage } from '../common/failure'

export const BUS_HOOK_USAGE = `usage: ostia bus hook <${AGENT_HOOK_CONTEXT_EVENTS.join('|')}|mod-ready|take|ack>`

function isContextEvent(value: unknown): value is AgentHookEvent {
  return AGENT_HOOK_CONTEXT_EVENTS.includes(value as AgentHookEvent)
}

const PENDING_HINTS: Record<MailPending, string> = {
  working: 'working: the agent reads it at its next prompt',
  'idle-no-wake': 'idle-no-wake: the agent reads it at its next prompt; nothing wakes it',
  'idle-will-wake': 'idle-will-wake: Ostia starts a turn in the idle agent to read it',
  draft: 'draft: the human has text in the agent’s prompt; it is read when they send it',
  'rate-limited': 'rate-limited: too many mail turns lately; it is read at the next prompt',
  hibernated:
    'hibernated: Ostia wakes the agent (a few times an hour at most) and it reads the message',
  'hooks-off':
    'hooks-off: its Ostia hooks are off, so it reads the message only with ostia bus inbox',
  'no-agent': 'no-agent: no agent runs in that pane; it reads the message with ostia bus inbox',
}

const BUS_WAIT_EXIT_TIMEOUT = 2

export function busSeconds(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined
  const seconds = Number(raw)
  if (raw.trim() === '' || !Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`${flag} expects seconds, got '${raw}'`)
  }
  return Math.round(seconds * 1000)
}

interface BusSendOk extends MailReceipt {
  ok: true
  id: string
}

export interface SentMessage extends MailReceipt {
  id: string
  to: string
  preview: string
  ts: string
}

export function sendExitCode(res: MailReceipt, waited: boolean): number {
  if (res.state === 'failed') return 1
  return waited && res.state !== 'delivered' ? BUS_WAIT_EXIT_TIMEOUT : 0
}

export interface BusHookIo {
  context: (event: AgentHookEvent) => Promise<{ text?: string | null; lease?: string }>
  ack: (lease: string) => Promise<unknown>
  take: () => Promise<unknown>
  modReady: (state: string) => Promise<unknown>
  out: (line: string) => void
  err: (line: string) => void
}

async function modHook(call: () => Promise<unknown>, io: BusHookIo): Promise<number> {
  try {
    const res = await call()
    if (res !== undefined && res !== null) io.out(JSON.stringify(res))
  } catch {
    return 0
  }
  return 0
}

export async function runBusHook(args: readonly string[], io: BusHookIo): Promise<number> {
  const [event, ...rest] = args
  if (event === 'take' && rest.length === 0) return modHook(() => io.take(), io)
  if (event === 'ack' && rest.length === 1) return modHook(() => io.ack(rest[0]), io)
  if (event === 'mod-ready' && rest.length >= 1 && rest.length <= 2) {
    return modHook(() => io.modReady(rest[1] ?? 'idle'), io)
  }
  if (rest.length > 0 || !isContextEvent(event)) {
    io.err(BUS_HOOK_USAGE)
    return 1
  }
  try {
    const res = await io.context(event)
    const output = agentHookOutput(event, res.text ?? undefined)
    if (output) io.out(output)
    if (res.lease) await io.ack(res.lease)
  } catch {
    return 0
  }
  return 0
}

function sentLine(message: SentMessage): string {
  return [message.ts, message.to, mailLabel(message), message.preview].join('\t')
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
  state: string
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
    const { values, positional } = parseArgs(rawArgs, {
      values: { wait: '--wait' },
      unknown: 'keep',
    })
    const [to, text] = positional
    if (!to || text === undefined) {
      console.error('ostia bus send: missing [--wait <s>] <toExternalId> "<msg>"')
      process.exitCode = 1
      return
    }
    const waitMs = busSeconds(values.wait, '--wait')
    const res = await conn.sendRequest<BusSendOk | ErrResult>('bus.send', { to, text, waitMs })
    if (res.ok) {
      console.log(JSON.stringify(res))
      if (res.state === 'queued' && res.pending) console.error(PENDING_HINTS[res.pending])
      process.exitCode = sendExitCode(res, waitMs !== undefined)
    } else {
      console.error(`ostia: bus send failed (${describeErrResult(res)})`)
      process.exitCode = 1
    }
  } else if (sub === 'inbox') {
    const { take } = parseArgs(rawArgs, { booleans: { take: '--take' } }).booleans
    const res = await conn.sendRequest<BusInboxResult | ErrResult>('bus.inbox', { take })
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
      context: (event) =>
        conn.sendRequest<{ text?: string | null; lease?: string }>('bus.context', { event }),
      ack: (lease) => conn.sendRequest('bus.ack', { lease }),
      take: () => conn.sendRequest('bus.take'),
      modReady: (state) => conn.sendRequest('bus.modReady', { state }),
      out: (line) => console.log(line),
      err: (line) => console.error(line),
    })
  } else if (sub === 'wait') {
    const { values } = parseArgs(rawArgs, { values: { timeout: '--timeout' } })
    const timeoutMs = busSeconds(values.timeout, '--timeout')
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
      if (res.state === 'queued' && res.pending) console.error(PENDING_HINTS[res.pending])
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
