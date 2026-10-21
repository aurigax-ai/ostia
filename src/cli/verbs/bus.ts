import {
  AGENT_HOOK_CONTEXT_EVENTS,
  type AgentHookEvent,
  agentHookOutput,
} from '@aurigax-ai/ostia-extension-sdk/contract/agentPlugins'
import type { MessageConnection } from 'vscode-jsonrpc/node'
import {
  busInboxText,
  type MailPending,
  type MailReceipt,
  mailLabel,
} from '../../shared/agents/busMessages'
import { parseArgs } from '../common/args'
import {
  commandLabel,
  describeErrResult,
  type ErrResult,
  failUsage,
  failVerb,
  failWith,
} from '../common/failure'
import { tsvLine } from '../common/lineField'

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

const BUS_EXIT_TIMEOUT = 3

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
  reply?: { messages: BusMessage[]; lease: string }
}

export interface SentMessage extends MailReceipt {
  id: string
  to: string
  preview: string
  ts: string
}

export function sendExitCode(res: MailReceipt & { reply?: unknown }, waited: boolean): number {
  if (res.state === 'failed') return 1
  return waited && !res.reply ? BUS_EXIT_TIMEOUT : 0
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

function replyProblem(to: string, receipt: MailReceipt): string {
  if (receipt.state === 'failed') return mailLabel(receipt)
  const hint = receipt.pending ? ` (${PENDING_HINTS[receipt.pending]})` : ''
  return `timed-out: ${to} sent no reply; the message is ${mailLabel(receipt)}${hint}`
}

function sentLine(message: SentMessage): string {
  return tsvLine([message.ts, message.to, mailLabel(message), message.preview])
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
  fromName?: string
  to: string
  text: string
  ts: string
  state: string
}
interface BusInboxResult {
  messages: BusMessage[]
  lease?: string
}
interface BusWaitResult extends BusInboxResult {
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

export function busSendArgs(
  argv: readonly string[],
): { to: string; text: string; wait?: string } | null {
  const waits = argv[0] === '--wait'
  const wait = waits ? argv[1] : undefined
  const args = waits ? argv.slice(2) : argv
  const end = args.indexOf('--')
  const [to, ...words] = end === -1 ? args : [...args.slice(0, end), ...args.slice(end + 1)]
  return to && words.length > 0 && (!waits || wait !== undefined)
    ? { to, text: words.join(' '), ...(wait === undefined ? {} : { wait }) }
    : null
}

export async function runBusVerb(conn: MessageConnection): Promise<void> {
  const sub = process.argv[3]
  const rawArgs = process.argv.slice(4)

  if (sub === 'send') {
    const args = busSendArgs(rawArgs)
    if (!args) {
      failVerb('missing arguments')
      return
    }
    const waitMs = busSeconds(args.wait, '--wait')
    const res = await conn.sendRequest<BusSendOk | ErrResult>('bus.send', {
      to: args.to,
      text: args.text,
      waitMs,
    })
    if (!res.ok) {
      failWith(describeErrResult(res))
      return
    }
    if (waitMs !== undefined) console.error(`sent ${res.id}`)
    if (waitMs === undefined) {
      console.log(JSON.stringify(res))
      if (res.state === 'queued' && res.pending) console.error(PENDING_HINTS[res.pending])
    } else if (res.reply) {
      console.log(busInboxText(res.reply.messages))
      await conn.sendRequest('bus.ack', { lease: res.reply.lease })
    } else {
      console.error(`${commandLabel()}: ${replyProblem(args.to, res)}`)
    }
    process.exitCode = sendExitCode(res, waitMs !== undefined)
  } else if (sub === 'inbox') {
    const { take, json } = parseArgs(rawArgs, {
      booleans: { take: '--take', json: '--json' },
    }).booleans
    const res = await conn.sendRequest<BusInboxResult | ErrResult>('bus.inbox', { take })
    if ('messages' in res) {
      if (!json && res.messages.length === 0) console.error(busInboxText([]))
      else console.log(json ? JSON.stringify(res.messages) : busInboxText(res.messages))
      if (res.lease) await conn.sendRequest('bus.ack', { lease: res.lease })
    } else {
      failWith(describeErrResult(res))
    }
  } else if (sub === 'sent') {
    const res = await conn.sendRequest<BusSentResult | ErrResult>('bus.sent')
    if ('messages' in res) {
      if (rawArgs.includes('--json')) console.log(JSON.stringify(res.messages))
      else if (res.messages.length === 0) console.error(sentLines([])[0])
      else for (const line of sentLines(res.messages)) console.log(line)
    } else {
      failWith(describeErrResult(res))
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
    const { values, booleans } = parseArgs(rawArgs, {
      values: { timeout: '--timeout' },
      booleans: { json: '--json' },
    })
    const timeoutMs = busSeconds(values.timeout, '--timeout')
    const res = await conn.sendRequest<BusWaitResult | ErrResult>('bus.wait', { timeoutMs })
    if ('messages' in res) {
      if (booleans.json) console.log(JSON.stringify(res))
      else if (res.timedOut) console.error(`${commandLabel()}: timed-out: no message arrived`)
      else console.log(busInboxText(res.messages))
      if (res.timedOut) process.exitCode = BUS_EXIT_TIMEOUT
      if (res.lease) await conn.sendRequest('bus.ack', { lease: res.lease })
    } else {
      failWith(describeErrResult(res))
    }
  } else if (sub === 'handoff') {
    const { values: flags, positional } = parseArgs(rawArgs, {
      values: { task: '--task', summary: '--summary' },
    })
    const to = positional[0]
    if (!to || !flags.task || !flags.summary) {
      failVerb('missing arguments')
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
      failWith(describeErrResult(res))
    }
  } else if (sub === 'claim') {
    const id = rawArgs[0]
    if (!id) {
      failVerb('missing arguments')
      return
    }
    const res = await conn.sendRequest<BusOk | ErrResult>('bus.claim', { id })
    if (res.ok) {
      console.log('ok')
    } else {
      failWith(describeErrResult(res))
    }
  } else if (sub === 'handoffs') {
    const { all } = parseArgs(rawArgs, { booleans: { all: '--all' } }).booleans
    const res = await conn.sendRequest<BusHandoffsResult | ErrResult>('bus.handoffs', { all })
    if ('handoffs' in res) {
      console.log(JSON.stringify(res.handoffs))
    } else {
      failWith(describeErrResult(res))
    }
  } else if (sub === 'done') {
    const id = rawArgs[0]
    if (!id) {
      failVerb('missing arguments')
      return
    }
    const res = await conn.sendRequest<BusOk | ErrResult>('bus.update', { id, state: 'completed' })
    if (res.ok) {
      console.log('ok')
    } else {
      failWith(describeErrResult(res))
    }
  } else {
    failUsage('bus')
  }
}
