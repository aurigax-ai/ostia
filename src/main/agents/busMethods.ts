import { randomUUID } from 'node:crypto'
import { BUS_SEND_TEXT_MAX } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { ErrorCodes, ResponseError } from 'vscode-jsonrpc/node'
import { MAIL_INBOX_FULL } from '../../shared/agents/agentIssues'
import { BUS_NAME_NOTICE, busContext, type MailPending } from '../../shared/agents/busMessages'
import { actThenConfirm, confirmed, mismatch } from '../../shared/common/actThenConfirm'
import { parseRemoteRef } from '../../shared/remote/remoteRef'
import { ensureCaps } from '../approvals/controlElevation'
import { type ControlMethodContext, registerControlMethod } from '../control/controlServer'
import { type PaneIdentity, resolveExternal } from '../control/idRegistry'
import type { AgentJournal } from '../diagnostics/agentJournal'
import { dropName, nameOf } from '../panes/paneNames'
import { ensurePaneReach, holdsPaneReach, type PaneReachDeps } from '../panes/paneReach'
import { type PaneRef, refProblem, resolvePaneRef } from '../panes/paneRef'
import {
  ackMail,
  addWaiter,
  type BusObservation,
  busHandoffs,
  enqueue,
  getMail,
  type HandedMail,
  type Handoff,
  type HandoffContext,
  type HandoffState,
  inboxFull,
  inboxOf,
  leaseMail,
  type Mail,
  markBusDirty,
  releaseMail,
  sentAfter,
  sentBy,
  setBusJournal,
  setBusObserver,
  setPending,
  sweepBus,
} from './busStore'
import { mailers } from './mailers'
import { withSenderName } from './mailSender'
import { takeMailTurn } from './mailTurn'
import { sendToRemote } from './remoteMail'

const MAX_HANDOFFS = 500

const MIN_WAIT_MS = 1000
const MAX_WAIT_MS = 590000
const DEFAULT_WAIT_MS = 30000
const SWEEP_MS = 5 * 60 * 1000

const NOT_FOUND = { ok: false, error: 'not-found' as const }
const UNKNOWN_PANE = {
  ok: false as const,
  error: 'unknown-pane' as const,
  message: 'no open pane has that id. List the panes you can reach with ostia pane list',
}
const INBOX_FULL = {
  ok: false,
  error: MAIL_INBOX_FULL,
  message: 'the receiver has too many undelivered messages; wait until it reads some',
}

let sweeper: NodeJS.Timeout | undefined

function clampTimeout(timeoutMs: number | undefined): number {
  if (typeof timeoutMs !== 'number' || Number.isNaN(timeoutMs)) return DEFAULT_WAIT_MS
  return Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, timeoutMs))
}

function wireMail(mail: Mail) {
  const { fromName } = withSenderName(mail)
  return {
    id: mail.id,
    kind: mail.kind,
    from: mail.from,
    ...(fromName ? { fromName } : {}),
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

const HANDOFF_STATES: readonly HandoffState[] = ['submitted', 'claimed', 'completed', 'failed']

export interface BusDeps {
  managerSendAllowed: () => boolean
  sent?: () => void
  announce: (from: PaneIdentity, to: PaneIdentity, text: string) => void
  pending: (pane: PaneIdentity) => Promise<MailPending>
  reach: PaneReachDeps
  observe?: (observation: BusObservation) => void
  journal?: Pick<AgentJournal, 'mail' | 'leaseTimeout' | 'hook' | 'undelivered'>
  agentBusy: (pane: PaneIdentity) => boolean
  hibernated: (paneId: string) => boolean
}

function receiverOf(to: unknown): PaneIdentity | undefined {
  const target = typeof to === 'string' ? resolveExternal(to) : undefined
  return target?.kind === 'pane' ? target : undefined
}

async function receiverFor(
  deps: BusDeps,
  to: unknown,
  ctx: ControlMethodContext,
): Promise<{ receiver: PaneIdentity } | { ok: false; error: string; message: string }> {
  if (typeof to !== 'string' || !to) return UNKNOWN_PANE
  const resolved: PaneRef = await resolvePaneRef(deps.reach, to, ctx, false)
  if ('found' in resolved) return { receiver: resolved.found }
  return { ok: false as const, ...refProblem(to, resolved) }
}

const UNDELIVERABLE: ReadonlySet<string> = new Set([
  'hibernated',
  'no-agent',
  'hooks-off',
  'idle-no-wake',
  'rate-limited',
])

async function queuedWithPending(deps: BusDeps, mail: Mail, to: PaneIdentity): Promise<Mail> {
  if (mail.state !== 'queued') return mail
  const pending = await deps.pending(to)
  setPending(mail.id, pending)
  if (UNDELIVERABLE.has(pending)) deps.journal?.undelivered(to.externalId, pending)
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
      if (typeof to === 'string' && parseRemoteRef(to)) {
        return { ok: true, ...receiptOf(await sendToRemote(ctx, to, text)) }
      }
      const found = await receiverFor(deps, to, ctx)
      if (!('receiver' in found)) return found
      const { receiver } = found
      if (script && receiver.manager) return UNKNOWN_PANE
      await ensurePaneReach(deps.reach, 'message', receiver, ctx, {
        ref: to,
        method: 'bus.send',
        detail: `to ${to}`,
      })
      if (inboxFull(receiver.externalId)) return INBOX_FULL
      const pair = `${from}>${receiver.externalId}`
      const waits = typeof waitMs === 'number'
      if (waits && replyWaits.has(pair)) return REPLY_BUSY
      if (waits) replyWaits.add(pair)
      try {
        const wakes = await holdsPaneReach(deps.reach, 'input', receiver, ctx)
        const posted = await postAndReadBack({
          from,
          to: receiver.externalId,
          text,
          ...(wakes ? { wakes: true as const } : {}),
        })
        const queued = await queuedWithPending(deps, posted, receiver)
        announceQueued(deps, queued, ctx.identity, receiver, text)
        deps.sent?.()
        if (typeof waitMs !== 'number' || queued.state === 'failed') {
          return { ok: true, ...receiptOf(queued) }
        }
        const abort = new AbortController()
        const closed = ctx.conn.onClose(() => abort.abort())
        const reply = await awaitReply(
          from,
          { from: receiver.externalId, after: queued.ts, sent: queued.id },
          clampTimeout(waitMs),
          abort.signal,
        )
        closed.dispose()
        const latest = getMail(queued.id) ?? queued
        return {
          ok: true,
          ...receiptOf(latest),
          ...(reply ? { reply: handOver(reply, ctx) } : {}),
        }
      } finally {
        if (waits) replyWaits.delete(pair)
      }
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
      const receipt = receiptOf(queued)
      return { ok: true, ...receipt, ...(receipt.state === 'leased' ? { state: 'delivered' } : {}) }
    },
  })
}

const REPLY_WATCH_MS = 200
const replyWaits = new Set<string>()
const REPLY_BUSY = {
  ok: false as const,
  error: 'busy' as const,
  message: 'another bus send --wait to that pane is waiting for its reply; wait for it first',
}

function awaitReply(
  me: string,
  of: { from: string; after: string; sent: string },
  timeoutMs: number,
  signal: AbortSignal,
): Promise<HandedMail | undefined> {
  const later = sentAfter(of.sent, of.after)
  const isReply = (mail: Mail): boolean =>
    mail.kind === 'message' && mail.from === of.from && later(mail)
  const fresh = leaseMail(me, 'read', isReply)
  if (fresh || signal.aborted) return Promise.resolve(fresh)
  return new Promise((resolve) => {
    const finish = (handed?: HandedMail): void => {
      clearTimeout(timer)
      clearInterval(watching)
      unregister()
      signal.removeEventListener('abort', onAbort)
      resolve(handed)
    }
    const onAbort = (): void => finish()
    const timer = setTimeout(finish, timeoutMs)
    const watching = setInterval(() => {
      if (getMail(of.sent)?.state === 'failed') finish()
    }, REPLY_WATCH_MS)
    const unregister = addWaiter(me, finish, isReply)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function handOver(handed: HandedMail | undefined, ctx: ControlMethodContext) {
  if (!handed) return { messages: [] }
  const me = ctx.identity.externalId
  ctx.conn.onClose(() => releaseMail(me, handed.lease))
  return { messages: handed.messages.map(wireMail), lease: handed.lease }
}

const HOOK_KINDS: Readonly<Record<string, string>> = {
  SessionStart: 'session-start',
  UserPromptSubmit: 'prompt-submit',
}

function hookKind(event: string | undefined): string {
  return (event && HOOK_KINDS[event]) || 'other'
}

function registerBusInboxMethods(deps: BusDeps): void {
  registerControlMethod('bus.inbox', {
    handler: (params, ctx) => {
      const { take } = (params ?? {}) as { take?: boolean }
      const me = ctx.identity.externalId
      if (take === true)
        return handOver(
          leaseMail(me, 'read', () => true),
          ctx,
        )
      return { messages: inboxOf(me).map(wireMail) }
    },
  })

  registerControlMethod('bus.context', {
    handler: (params, ctx) => {
      const { event, source } = (params ?? {}) as { event?: string; source?: string }
      const me = ctx.identity.externalId
      deps.journal?.hook(me, hookKind(event))
      const fresh = inboxOf(me).filter((mail) => mail.state === 'queued' && !mail.quiet)
      const context = busContext(
        fresh.map((mail) => ({ ...withSenderName(mail), text: mail.text ?? '' })),
      )
      const notice =
        event === 'SessionStart' &&
        (source === 'resume' || source === 'clear') &&
        !ctx.identity.manager &&
        !nameOf(ctx.identity.paneId)
          ? BUS_NAME_NOTICE
          : null
      const joined = (text: string | null): string | null =>
        [text, notice].filter(Boolean).join('\n') || null
      if (!context) return { text: joined(null) }
      if (context.shown.length === 0) return { text: joined(context.text) }
      const shown = new Set(context.shown)
      const leased = leaseMail(me, event === 'SessionStart' ? 'start' : 'prompt', (mail) =>
        shown.has(mail.id),
      )
      if (!leased) return { text: joined(null) }
      ctx.conn.onClose(() => releaseMail(me, leased.lease))
      return { text: joined(context.text), lease: leased.lease }
    },
  })

  registerControlMethod('bus.modReady', {
    handler: (params, ctx) => {
      const { state } = (params ?? {}) as { state?: string }
      const me = ctx.identity.externalId
      if (state === 'gone') {
        mailers.clear(me)
        if (!deps.hibernated(ctx.identity.paneId)) dropName(ctx.identity.paneId)
      } else mailers.set(me, state === 'draft')
      return { ok: true }
    },
  })

  registerControlMethod('bus.take', {
    handler: (_params, ctx) => takeMailTurn(ctx.identity.externalId, deps.agentBusy(ctx.identity)),
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

      const fresh = leaseMail(me, 'read', () => true)
      if (fresh) return Promise.resolve({ ...handOver(fresh, ctx), timedOut: false })

      return new Promise<ReturnType<typeof handOver> & { timedOut: boolean }>((resolve) => {
        let settled = false
        const timer = setTimeout(() => {
          finish(undefined, true)
        }, clamped)
        const finish = (handed: HandedMail | undefined, timedOut: boolean): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          unregister()
          closed.dispose()
          resolve({ ...handOver(handed, ctx), timedOut })
        }
        const unregister = addWaiter(me, (handed) => finish(handed, false))
        const closed = ctx.conn.onClose(() => finish(undefined, true))
      })
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
      const found = await receiverFor(deps, to, ctx)
      if (!('receiver' in found)) return found
      const { receiver } = found
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
      const wakes = await holdsPaneReach(deps.reach, 'input', receiver, ctx)
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
        ...(wakes ? { wakes: true as const } : {}),
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
      if (!HANDOFF_STATES.includes(state)) {
        return {
          ok: false,
          error: 'bad-state',
          message: `state must be one of ${HANDOFF_STATES.join(', ')}`,
        }
      }
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
