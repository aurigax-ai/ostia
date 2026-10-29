import {
  ackMail,
  addWaiter,
  enqueue,
  getMail,
  type HandedMail,
  inboxFull,
  inboxOf,
  leaseMail,
  type Mail,
  sentBy,
} from '../main/agents/busStore'
import { busContext } from '../shared/agents/busMessages'
import type { JobRecord, Jobs } from './jobs'

const WAIT_DEFAULT_MS = 30_000
const WAIT_MAX_MS = 590_000

type Method = (params: unknown) => unknown

function wire(jobs: Jobs, mail: Mail) {
  const sender = jobs.get(mail.from)
  return {
    id: mail.id,
    kind: mail.kind,
    from: mail.from,
    ...(sender?.name ? { fromName: sender.name } : {}),
    to: mail.to,
    text: mail.text ?? '',
    ts: mail.ts,
    state: mail.state,
  }
}

function receipt(mail: Mail) {
  return { id: mail.id, state: mail.state, ...(mail.via ? { via: mail.via } : {}) }
}

function handOver(jobs: Jobs, handed: HandedMail | undefined) {
  if (!handed) return { messages: [] }
  return { messages: handed.messages.map((mail) => wire(jobs, mail)), lease: handed.lease }
}

function waitFor(me: string, timeoutMs: number): Promise<HandedMail | undefined> {
  return new Promise((resolve) => {
    const finish = (handed?: HandedMail): void => {
      clearTimeout(timer)
      resolve(handed)
    }
    const timer = setTimeout(finish, timeoutMs)
    addWaiter(me, finish, () => true)
  })
}

export function busMethods(jobs: Jobs, pane: JobRecord): Record<string, Method> {
  const me = pane.pane
  return {
    'bus.send': (params) => {
      const { to, text } = (params ?? {}) as { to?: string; text?: string }
      const receiver = typeof to === 'string' ? jobs.resolve(to) : undefined
      if (!receiver)
        return {
          ok: false,
          error: 'unknown-pane',
          message: 'no pane on this host has that id or name',
        }
      if (typeof text !== 'string' || !text)
        return { ok: false, error: 'bad-request', message: 'text' }
      if (inboxFull(receiver.pane))
        return {
          ok: false,
          error: 'inbox-full',
          message: 'the receiver has too many undelivered messages',
        }
      const mail = enqueue({ from: me, to: receiver.pane, text })
      return { ok: true, ...receipt(getMail(mail.id) ?? mail) }
    },
    'bus.inbox': (params) => {
      const { take } = (params ?? {}) as { take?: boolean }
      if (take === true)
        return handOver(
          jobs,
          leaseMail(me, 'read', () => true),
        )
      return { messages: inboxOf(me).map((mail) => wire(jobs, mail)) }
    },
    'bus.context': (params) => {
      const { event } = (params ?? {}) as { event?: string }
      const fresh = inboxOf(me).filter((mail) => mail.state === 'queued' && !mail.quiet)
      const context = busContext(fresh.map((mail) => wire(jobs, mail)))
      if (!context || context.shown.length === 0) return { text: context?.text ?? null }
      const shown = new Set(context.shown)
      const leased = leaseMail(me, event === 'SessionStart' ? 'start' : 'prompt', (mail) =>
        shown.has(mail.id),
      )
      return leased ? { text: context.text, lease: leased.lease } : { text: null }
    },
    'bus.ack': (params) => {
      const { lease } = (params ?? {}) as { lease?: string }
      return { acked: typeof lease === 'string' ? ackMail(me, lease).length : 0 }
    },
    'bus.sent': () => ({
      messages: sentBy(me).map((mail) => ({
        ...receipt(mail),
        to: mail.to,
        preview: mail.preview,
        ts: mail.ts,
      })),
    }),
    'bus.wait': async (params) => {
      const { timeoutMs } = (params ?? {}) as { timeoutMs?: number }
      const clamped = Math.min(WAIT_MAX_MS, Math.max(1000, timeoutMs ?? WAIT_DEFAULT_MS))
      const handed = leaseMail(me, 'read', () => true) ?? (await waitFor(me, clamped))
      return { ...handOver(jobs, handed), timedOut: handed === undefined }
    },
    'bus.modReady': () => ({ ok: true }),
    'bus.take': () => null,
  }
}
