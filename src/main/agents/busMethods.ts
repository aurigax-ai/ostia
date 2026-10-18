import { randomUUID } from 'node:crypto'
import { BUS_SEND_TEXT_MAX } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { ErrorCodes, ResponseError } from 'vscode-jsonrpc/node'
import { MAIL_INBOX_FULL } from '../../shared/agents/agentIssues'
import { type MailPending, busContext } from '../../shared/agents/busMessages'
import { actThenConfirm, confirmed, mismatch } from '../../shared/common/actThenConfirm'
import { ensureCaps } from '../approvals/controlElevation'
import { registerControlMethod } from '../control/controlServer'
import { type PaneIdentity, resolveExternal } from '../control/idRegistry'
import type { AgentJournal } from '../diagnostics/agentJournal'
import { type PaneReachDeps, ensurePaneReach } from '../panes/paneReach'
import {
  type BusObservation,
  type Handoff,
  type HandoffContext,
  type HandoffState,
  type Mail,
  ackMail,
  addWaiter,
  busHandoffs,
  enqueue,
  getMail,
  inboxFull,
  inboxOf,
  leaseMail,
  markBusDirty,
  sentBy,
  setBusJournal,
  setBusObserver,
  setPending,
  sweepBus,
  takeMail,
  whenSettled,
} from './busStore'

const MAX_HANDOFFS = 500

const MIN_WAIT_MS = 1000
const MAX_WAIT_MS = 120000
const DEFAULT_WAIT_MS = 30000
const SWEEP_MS = 5 * 60 * 1000

const NOT_FOUND = { ok: false, error: 'not-found' as const }
const UNKNOWN_PANE = {
  ok: false,
  error: 'unknown-pane' as const,
  message: 'no open pane has that id (see: ostia pane list)',
}
const INBOX_FULL = {
  ok: false,
  error: MAIL_INBOX_FULL,
  message: 'the receiver has too many undelivered messages; wait until it reads some',
}

type WaitResult = { messages: Mail[]; timedOut: boolean }

let sweeper: NodeJS.Timeout | undefined

function clampTimeout(timeoutMs: number | undefined): number {
  if (typeof timeoutMs !== 'number' || Number.isNaN(timeoutMs)) return DEFAULT_WAIT_MS
  return Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, timeoutMs))
}

function wireMail(mail: Mail) {
  return {
    id: mail.id,
    kind: mail.kind,
    from: mail.from,
    to: mail.to,
    text: mail.text ?? '',
    ts: mail.ts,
    state: mail.state,
    ...(mail.task ? { task: true as const } : {}),
  }
}

function receiptOf(mail: Mail) {
  return {
    id: mail.id,
    state: mail.state,
    ...(mail.via ? { via: mail.via } : {}),
    ...(mail.reason ? { reason: mail.reason } : {}),
    ...(mail.state === 'queued' && mail.pending ? { pending: mail.pending } : {}),
  }
}

function enforceHandoffCap(): void {
  const handoffs = busHandoffs()
  while (handoffs.length > MAX_HANDOFFS) {
    const idx = handoffs.findIndex((h) => h.state === 'completed' || h.state === 'failed')
    handoffs.splice(idx === -1 ? 0 : idx, 1)
  }
}

async function postAndReadBack(draft: Parameters<typeof enqueue>[0]): Promise<Mail> {
  let id = ''
  const seen = await actThenConfirm<Mail>({
    act: () => {
      id = enqueue(draft).id
    },
    observe: () => {
      const mail = getMail(id)
      return mail ? confirmed(mail) : mismatch(`not-queued: ${id} is not in the bus store`)
    },
    signal: () => () => {},
    timeoutMs: 0,
    onTimeout: () => mismatch(`not-queued: ${id} is not in the bus store`),
  })
  if (!seen.ok) throw new ResponseError(ErrorCodes.InternalError, seen.reason)
  return seen.value
}

export interface BusDeps {
  managerSendAllowed: () => boolean
  sent?: () => void
  announce: (from: PaneIdentity, to: PaneIdentity, text: string) => void
  pending: (pane: PaneIdentity) => Promise<MailPending>
  reach: Omit<PaneReachDeps, 'processPane'>
  observe?: (observation: BusObservation) => void
  journal?: Pick<AgentJournal, 'mail' | 'leaseTimeout'>
}

function receiverOf(to: unknown): PaneIdentity | undefined {
  const target = typeof to === 'string' ? resolveExternal(to) : undefined
  return target?.kind === 'pane' ? target : undefined
}

async function queuedWithPending(deps: BusDeps, mail: Mail, to: PaneIdentity): Promise<Mail> {
  if (mail.state !== 'queued') return mail
  setPending(mail.id, await deps.pending(to))
  return getMail(mail.id) ?? mail
}

export function registerBusMethods(deps: BusDeps): void {
  setBusObserver(deps.observe)
  setBusJournal(deps.journal)
  sweeper ??= setInterval(() => sweepBus(), SWEEP_MS).unref()
  registerBusSendMethods(deps)
  registerBusInboxMethods(deps)
  registerBusHandoffMethods(deps)
}

function announceQueued(
  deps: BusDeps,
  mail: Mail,
  from: PaneIdentity,
  to: PaneIdentity,
  text: string,
): void {
  if (mail.state === 'queued' && to.externalId !== from.externalId) deps.announce(from, to, text)
}

function registerBusSendMethods(deps: BusDeps): void {
  registerControlMethod('bus.send', {
    scripts: true,
    handler: async (params, ctx) => {
      const { to, text, waitMs } = (params ?? {}) as {
        to: string
        text: string
        waitMs?: number
      }
      const from = ctx.identity.externalId
      const script = ctx.identity.kind === 'script'
      if (ctx.identity.manager && !deps.managerSendAllowed()) {
        throw new ResponseError(
          ErrorCodes.InvalidRequest,
          'limit: the manager sent too many bus messages this minute',
        )
      }
      if (script && (typeof to !== 'string' || !to)) {
        throw new ResponseError(ErrorCodes.InvalidParams, 'bad-request: to')
      }
      if (typeof text !== 'string' || !text) {
        throw new ResponseError(ErrorCodes.InvalidParams, 'bad-request: text')
      }
      const receiver = receiverOf(to)
      if (!receiver || (script && receiver.manager)) return UNKNOWN_PANE
      await ensurePaneReach(deps.reach, 'message', receiver, ctx, {
        ref: to,
        method: 'bus.send',
        detail: `to ${to}`,
      })
      if (inboxFull(receiver.externalId)) return INBOX_FULL
      const posted = await postAndReadBack({ from, to: receiver.externalId, text })
      const queued = await queuedWithPending(deps, posted, receiver)
      const abort = new AbortController()
      const closed = ctx.conn.onClose(() => abort.abort())
      const settled =
        typeof waitMs === 'number' && queued.state === 'queued'
          ? await whenSettled(queued.id, clampTimeout(waitMs), abort.signal)
          : queued
      closed.dispose()
      const mail = settled ?? queued
      announceQueued(deps, queued, ctx.identity, receiver, text)
      deps.sent?.()
      return { ok: true, ...receiptOf(mail) }
    },
  })

  registerControlMethod('ext.busSend', {
    callers: 'extensions',
    cap: 'send-other-pane',
    handler: async (params, ctx) => {
      const { to, text } = (params ?? {}) as { to?: unknown; text?: unknown }
      if (typeof text !== 'string' || !text || text.length > BUS_SEND_TEXT_MAX) {
        return {
          ok: false,
          error: 'invalid-params',
          message: `text is 1-${BUS_SEND_TEXT_MAX} characters`,
        }
      }
      await ensureCaps(
        ctx.authed,
        ctx.identity,
        ['all-workspaces'],
        'ext.busSend',
        `to ${String(to)}`,
      )
      const receiver = receiverOf(to)
      if (!receiver || receiver.manager) return UNKNOWN_PANE
      if (inboxFull(receiver.externalId)) return INBOX_FULL
      const from = ctx.identity.extId ?? ctx.identity.externalId
      const posted = await postAndReadBack({ from, to: receiver.externalId, text })
      const queued = await queuedWithPending(deps, posted, receiver)
      announceQueued(deps, queued, ctx.identity, receiver, text)
      return { ok: true, ...receiptOf(queued) }
    },
  })
}

function registerBusInboxMethods(deps: BusDeps): void {
  registerControlMethod('bus.inbox', {
    handler: (params, ctx) => {
      const { take } = (params ?? {}) as { take?: boolean }
      const me = ctx.identity.externalId
      const messages = take === true ? takeMail(me, 'read', () => true) : inboxOf(me)
      return { messages: messages.map(wireMail) }
    },
  })

  registerControlMethod('bus.context', {
    handler: (params, ctx) => {
      const { event } = (params ?? {}) as { event?: string }
      const me = ctx.identity.externalId
      const fresh = inboxOf(me).filter((mail) => mail.state === 'queued' && !mail.quiet)
      const context = busContext(fresh.map((mail) => ({ ...mail, text: mail.text ?? '' })))
      if (!context) return { text: null }
      const shown = new Set(context.shown)
      const leased = leaseMail(me, event === 'SessionStart' ? 'start' : 'prompt', (mail) =>
        shown.has(mail.id),
      )
      return leased ? { text: context.text, lease: leased.lease } : { text: null }
    },
  })

  registerControlMethod('bus.ack', {
    handler: (params, ctx) => {
      const { lease } = (params ?? {}) as { lease?: string }
      return {
        acked: typeof lease === 'string' ? ackMail(ctx.identity.externalId, lease).length : 0,
      }
    },
  })

  registerControlMethod('bus.sent', {
    handler: async (_params, ctx) => {
      const mine = sentBy(ctx.identity.externalId)
      const messages = await Promise.all(
        mine.map(async (mail) => {
          const target = receiverOf(mail.to)
          const fresh =
            mail.state === 'queued' && target ? await queuedWithPending(deps, mail, target) : mail
          return {
            ...receiptOf(fresh),
            to: fresh.to,
            preview: fresh.preview,
            ts: fresh.ts,
          }
        }),
      )
      return { messages }
    },
  })

  registerControlMethod('bus.wait', {
    handler(params, ctx) {
      const { timeoutMs } = (params ?? {}) as { timeoutMs?: number }
      const me = ctx.identity.externalId
      const clamped = clampTimeout(timeoutMs)

      const fresh = takeMail(me, 'read', () => true)
      if (fresh.length > 0) {
        return Promise.resolve({ messages: fresh.map(wireMail), timedOut: false })
      }

      return new Promise<{ messages: ReturnType<typeof wireMail>[]; timedOut: boolean }>(
        (resolve) => {
          let settled = false
          const timer = setTimeout(() => {
            finish({ messages: [], timedOut: true })
          }, clamped)
          const finish = (result: WaitResult): void => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            unregister()
            closed.dispose()
            resolve({ messages: result.messages.map(wireMail), timedOut: result.timedOut })
          }
          const unregister = addWaiter(me, (messages) => finish({ messages, timedOut: false }))
          const closed = ctx.conn.onClose(() => finish({ messages: [], timedOut: true }))
        },
      )
    },
  })
}

function registerBusHandoffMethods(deps: BusDeps): void {
  registerControlMethod('bus.handoff', {
    handler: async (params, ctx) => {
      const { to, task, summary, context } = (params ?? {}) as {
        to: string
        task: string
        summary: string
        context?: HandoffContext
      }
      const from = ctx.identity.externalId
      const receiver = receiverOf(to)
      if (!receiver) return UNKNOWN_PANE
      await ensurePaneReach(deps.reach, 'message', receiver, ctx, {
        ref: to,
        method: 'bus.handoff',
        detail: `to ${to}`,
      })
      if (!summary?.trim()) {
        return {
          ok: false,
          error: 'summary-required',
          message: 'a handoff must carry a non-empty summary for the receiving agent',
        }
      }
      if (inboxFull(receiver.externalId)) return INBOX_FULL
      const now = new Date().toISOString()
      const id = randomUUID()
      const handoff: Handoff = {
        id,
        from,
        to: receiver.externalId,
        task,
        summary,
        state: 'submitted',
        context,
        ts: now,
        updatedAt: now,
      }
      busHandoffs().push(handoff)
      enforceHandoffCap()
      markBusDirty()
      const posted = await postAndReadBack({
        from,
        to: receiver.externalId,
        text: `handoff ${id}: ${task} — ${summary}`,
        task: true,
      })
      if (!busHandoffs().some((h) => h.id === id)) {
        throw new ResponseError(
          ErrorCodes.InternalError,
          `not-recorded: handoff ${id} is not on the list`,
        )
      }
      const queued = await queuedWithPending(deps, posted, receiver)
      announceQueued(deps, queued, ctx.identity, receiver, `${task} — ${summary}`)
      return { ok: true, ...receiptOf(queued), id }
    },
  })

  registerControlMethod('bus.claim', {
    handler: (params, ctx) => {
      const { id } = (params ?? {}) as { id: string }
      const handoff = busHandoffs().find((h) => h.id === id)
      if (!handoff || handoff.to !== ctx.identity.externalId) return NOT_FOUND
      handoff.state = 'claimed'
      handoff.updatedAt = new Date().toISOString()
      markBusDirty()
      return { ok: true }
    },
  })

  registerControlMethod('bus.handoffs', {
    handler: async (params, ctx) => {
      const { all } = (params ?? {}) as { all?: boolean }
      const me = ctx.identity.externalId
      if (all) {
        await ensureCaps(ctx.authed, ctx.identity, ['all-workspaces'], 'bus.handoffs --all', '')
        return { handoffs: busHandoffs() }
      }
      return { handoffs: busHandoffs().filter((h) => h.to === me || h.from === me) }
    },
  })

  registerControlMethod('bus.update', {
    handler: (params, ctx) => {
      const { id, state } = (params ?? {}) as { id: string; state: HandoffState }
      const me = ctx.identity.externalId
      const handoff = busHandoffs().find((h) => h.id === id)
      if (!handoff || (handoff.to !== me && handoff.from !== me)) return NOT_FOUND
      handoff.state = state
      handoff.updatedAt = new Date().toISOString()
      markBusDirty()
      return { ok: true }
    },
  })
}
