/**
 * `bus` toolbelt service (agent-toolbelt #7, capability 'send-other-pane' — elevated, already
 * exists for `command.exec`'s cross-pane gate — reused here rather than adding a new one).
 * A cross-agent mailbox + task-handoff service so agents running in different panes can
 * coordinate over the CLI: point-to-point messages (`inboxes[externalId]`) plus a small
 * task-handoff ledger (`handoffs`), both in ONE global store (`storePath('bus', 'global')`) —
 * unlike `wiki.ts`/`vault.ts`/`kanban.ts` there is no project scope, since coordination is
 * inherently cross-pane (and often cross-project) rather than something a single project's
 * workDir would naturally own.
 *
 * `send-other-pane` gates writing into ANOTHER agent's inbox (`bus.send`, `bus.handoff`) —
 * same trust posture as `command.exec` targeting another pane. Sending to your own inbox is
 * always allowed under default caps (a self-note isn't a cross-pane action), so `bus.send`
 * is registered with no static `cap` and checks the elevation manually once it knows `to`.
 * Reading your OWN inbox (`bus.inbox`, `bus.wait`) and claiming/updating a handoff already
 * addressed to (or from) you need no capability beyond being an authenticated pane.
 *
 * `bus.wait` long-polls: it resolves as soon as `bus.send`/`bus.handoff` deliver a message to
 * the caller, or after `timeoutMs` elapses, whichever comes first. This needs an in-memory
 * waiter registry (`Map<externalId, Waiter[]>`) alongside the on-disk store — waiters are
 * inherently per-process, tied to a live `bus.wait` request awaiting a response, so they
 * don't need to (and can't usefully) survive a restart the way `inboxes`/`handoffs` do.
 * Delivery and timeout race to resolve the same promise; `finish` is idempotent (a `settled`
 * flag) so whichever fires first wins and the loser's timer/registration is torn down.
 */
import { randomUUID } from 'node:crypto'
import { ErrorCodes, ResponseError } from 'vscode-jsonrpc/node'
import type { Capability } from '../shared/capabilities'
import { connHasCap } from './controlAuth'
import { registerControlMethod } from './controlServer'
import { loadJson, saveJson, storePath } from './jsonStore'

export interface Message {
  id: string
  from: string
  to: string
  text: string
  ts: string
}

export type HandoffState = 'submitted' | 'claimed' | 'completed' | 'failed'

export interface HandoffContext {
  artifacts?: string[]
  workDir?: string
}

export interface Handoff {
  id: string
  from: string
  to: string
  task: string
  summary: string
  state: HandoffState
  context?: HandoffContext
  ts: string
  updatedAt: string
}

interface BusData {
  inboxes: Record<string, Message[]>
  handoffs: Handoff[]
}

/** A JSON-RPC error matching `controlServer.ts`'s `needsElevation` (not exported from there). */
function needsElevation(cap: Capability): ResponseError<void> {
  return new ResponseError(ErrorCodes.InvalidRequest, `needs-elevation: ${cap}`)
}

function busPath(): string {
  return storePath('bus', 'global')
}

function loadBus(): BusData {
  return loadJson<BusData>(busPath(), { inboxes: {}, handoffs: [] })
}

function saveBus(data: BusData): void {
  saveJson(busPath(), data)
}

const NOT_FOUND = { ok: false, error: 'not-found' as const }

type WaitResult = { messages: Message[]; timedOut: boolean }
type Waiter = (result: WaitResult) => void

/** externalId -> pending `bus.wait` resolvers for that inbox. */
const waiters = new Map<string, Waiter[]>()

/** Resolves (and clears) every waiter registered for `to` with the post-delivery inbox. */
function wake(to: string, messages: Message[]): void {
  const pending = waiters.get(to)
  if (!pending || pending.length === 0) return
  waiters.delete(to)
  for (const resolve of pending) resolve({ messages, timedOut: false })
}

/** Registers a waiter for `externalId`; returns an idempotent unregister function. */
function addWaiter(externalId: string, resolve: Waiter): () => void {
  const list = waiters.get(externalId) ?? []
  list.push(resolve)
  waiters.set(externalId, list)
  return () => {
    const cur = waiters.get(externalId)
    if (!cur) return
    const idx = cur.indexOf(resolve)
    if (idx !== -1) cur.splice(idx, 1)
    if (cur.length === 0) waiters.delete(externalId)
  }
}

/** Appends `msg` to `data.inboxes[msg.to]`, saves, and wakes any waiter for the recipient. */
function deliver(data: BusData, msg: Message): void {
  const inbox = data.inboxes[msg.to] ?? []
  inbox.push(msg)
  data.inboxes[msg.to] = inbox
  saveBus(data)
  wake(msg.to, inbox)
}

export function registerBusMethods(): void {
  registerControlMethod('bus.send', {
    // No static cap: self-sends need none, cross-pane sends need 'send-other-pane' — checked
    // by hand below once `to` is known, per the module doc comment above.
    handler: (params, ctx) => {
      const { to, text } = (params ?? {}) as { to: string; text: string }
      const from = ctx.identity.externalId
      if (to !== from && !connHasCap(ctx.authed, 'send-other-pane')) {
        throw needsElevation('send-other-pane')
      }
      const data = loadBus()
      const id = randomUUID()
      deliver(data, { id, from, to, text, ts: new Date().toISOString() })
      return { ok: true, id }
    },
  })

  registerControlMethod('bus.inbox', {
    handler: (params, ctx) => {
      const { drain } = (params ?? {}) as { drain?: boolean }
      const data = loadBus()
      const me = ctx.identity.externalId
      const messages = data.inboxes[me] ?? []
      if (drain && messages.length > 0) {
        data.inboxes[me] = []
        saveBus(data)
      }
      return { messages }
    },
  })

  registerControlMethod('bus.wait', {
    handler(params, ctx) {
      const { timeoutMs } = (params ?? {}) as { timeoutMs?: number }
      const me = ctx.identity.externalId
      return new Promise<WaitResult>((resolve) => {
        let settled = false
        // `timer` and `unregister` are read inside `finish`, which only ever runs
        // asynchronously (from the timeout firing or `wake` delivering a message) — by then
        // both are assigned, even though `finish` is declared before `unregister` below.
        const timer = setTimeout(() => {
          const data = loadBus()
          finish({ messages: data.inboxes[me] ?? [], timedOut: true })
        }, timeoutMs ?? 30000)
        const finish = (result: WaitResult): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          unregister()
          resolve(result)
        }
        const unregister = addWaiter(me, finish)
      })
    },
  })

  registerControlMethod('bus.handoff', {
    cap: 'send-other-pane',
    handler: (params, ctx) => {
      const { to, task, summary, context } = (params ?? {}) as {
        to: string
        task: string
        summary: string
        context?: HandoffContext
      }
      if (!summary?.trim()) {
        return {
          ok: false,
          error: 'summary-required',
          message: 'a handoff must carry a non-empty summary for the receiving agent',
        }
      }
      const from = ctx.identity.externalId
      const now = new Date().toISOString()
      const id = randomUUID()
      const data = loadBus()
      const handoff: Handoff = {
        id,
        from,
        to,
        task,
        summary,
        state: 'submitted',
        context,
        ts: now,
        updatedAt: now,
      }
      data.handoffs.push(handoff)
      deliver(data, {
        id: randomUUID(),
        from,
        to,
        text: `handoff ${id}: ${task} — ${summary}`,
        ts: now,
      })
      return { ok: true, id }
    },
  })

  registerControlMethod('bus.claim', {
    handler: (params, ctx) => {
      const { id } = (params ?? {}) as { id: string }
      const data = loadBus()
      const handoff = data.handoffs.find((h) => h.id === id)
      if (!handoff || handoff.to !== ctx.identity.externalId) return NOT_FOUND
      handoff.state = 'claimed'
      handoff.updatedAt = new Date().toISOString()
      saveBus(data)
      return { ok: true }
    },
  })

  registerControlMethod('bus.handoffs', {
    handler: (params, ctx) => {
      const { mine } = (params ?? {}) as { mine?: boolean }
      const data = loadBus()
      const me = ctx.identity.externalId
      const handoffs = mine
        ? data.handoffs.filter((h) => h.to === me || h.from === me)
        : data.handoffs
      return { handoffs }
    },
  })

  registerControlMethod('bus.update', {
    handler: (params, ctx) => {
      const { id, state } = (params ?? {}) as { id: string; state: HandoffState }
      const data = loadBus()
      const me = ctx.identity.externalId
      const handoff = data.handoffs.find((h) => h.id === id)
      if (!handoff || (handoff.to !== me && handoff.from !== me)) return NOT_FOUND
      handoff.state = state
      handoff.updatedAt = new Date().toISOString()
      saveBus(data)
      return { ok: true }
    },
  })
}
