import { randomUUID } from 'node:crypto'
import { ensureCaps } from './controlElevation'
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

const MAX_INBOX_MESSAGES = 200
const MAX_HANDOFFS = 500

const MIN_WAIT_MS = 1000
const MAX_WAIT_MS = 120000
const DEFAULT_WAIT_MS = 30000

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

const waiters = new Map<string, Waiter[]>()

function wake(to: string, messages: Message[]): void {
  const pending = waiters.get(to)
  if (!pending || pending.length === 0) return
  waiters.delete(to)
  for (const resolve of pending) resolve({ messages, timedOut: false })
}

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

function clampTimeout(timeoutMs: number | undefined): number {
  if (typeof timeoutMs !== 'number' || Number.isNaN(timeoutMs)) return DEFAULT_WAIT_MS
  return Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, timeoutMs))
}

function deliver(data: BusData, msg: Message): void {
  const inbox = data.inboxes[msg.to] ?? []
  inbox.push(msg)
  while (inbox.length > MAX_INBOX_MESSAGES) inbox.shift()
  data.inboxes[msg.to] = inbox
  saveBus(data)
  wake(msg.to, inbox)
}

function enforceHandoffCap(data: BusData): void {
  while (data.handoffs.length > MAX_HANDOFFS) {
    const idx = data.handoffs.findIndex((h) => h.state === 'completed' || h.state === 'failed')
    data.handoffs.splice(idx === -1 ? 0 : idx, 1)
  }
}

export function postBusMessage(from: string, to: string, text: string): string {
  const id = randomUUID()
  deliver(loadBus(), { id, from, to, text, ts: new Date().toISOString() })
  return id
}

export function registerBusMethods(): void {
  registerControlMethod('bus.send', {
    handler: async (params, ctx) => {
      const { to, text } = (params ?? {}) as { to: string; text: string }
      const from = ctx.identity.externalId
      if (to !== from) {
        await ensureCaps(ctx.authed, ctx.identity, ['send-other-pane'], 'bus.send', `to ${to}`)
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
      const clamped = clampTimeout(timeoutMs)

      const already = loadBus().inboxes[me] ?? []
      if (already.length > 0) {
        return Promise.resolve({ messages: already, timedOut: false })
      }

      return new Promise<WaitResult>((resolve) => {
        let settled = false
        const timer = setTimeout(() => {
          const data = loadBus()
          finish({ messages: data.inboxes[me] ?? [], timedOut: true })
        }, clamped)
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
    handler: async (params, ctx) => {
      const { to, task, summary, context } = (params ?? {}) as {
        to: string
        task: string
        summary: string
        context?: HandoffContext
      }
      const from = ctx.identity.externalId
      if (to !== from) {
        await ensureCaps(ctx.authed, ctx.identity, ['send-other-pane'], 'bus.handoff', `to ${to}`)
      }
      if (!summary?.trim()) {
        return {
          ok: false,
          error: 'summary-required',
          message: 'a handoff must carry a non-empty summary for the receiving agent',
        }
      }
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
      enforceHandoffCap(data)
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
    handler: async (params, ctx) => {
      const { all } = (params ?? {}) as { all?: boolean }
      const me = ctx.identity.externalId
      if (all) {
        await ensureCaps(ctx.authed, ctx.identity, ['all-workspaces'], 'bus.handoffs --all', '')
        return { handoffs: loadBus().handoffs }
      }
      const data = loadBus()
      const handoffs = data.handoffs.filter((h) => h.to === me || h.from === me)
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
