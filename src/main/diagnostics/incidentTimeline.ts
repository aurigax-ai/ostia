import { AsyncLocalStorage } from 'node:async_hooks'
import {
  INCIDENT_EVENTS_MAX,
  INCIDENT_KEEP_MS,
  INCIDENT_KEPT_MAX,
  INCIDENT_PANES_MAX,
  INCIDENT_STALL_MS,
  INCIDENT_WINDOW_MS,
  type IncidentEvent,
  type IncidentSnapshot,
} from '../../shared/agents/incident'

type Distribute<T> = T extends unknown
  ? Omit<T, 'at' | 'from'> & { at: number; from?: string }
  : never
type RawEvent = Distribute<IncidentEvent>

const METHOD = /^[a-z][A-Za-z.]{0,60}$/
const CODE = /^[a-z][a-z.-]{0,40}$/
const MERGE_MS = 60_000
const TOTALS_KEYS_MAX = 120

interface Open {
  paneId: string
  method: string
  caller: string | undefined
  began: number
}

export interface IncidentCall {
  bind: (paneId: string) => void
  phase: (name: string) => void
  end: (code?: string) => void
  cancel: () => void
}

const calls = new AsyncLocalStorage<IncidentCall>()

export const runInIncident = <T>(call: IncidentCall | undefined, run: () => T): T =>
  call ? calls.run(call, run) : run()

export const bindIncident = (paneId: string): void => calls.getStore()?.bind(paneId)

export interface IncidentTimelineDeps {
  now: () => number
  snapshot: (paneId: string) => Promise<IncidentSnapshot | undefined>
}

export interface IncidentTake {
  paneId: string
  agent: string
  events: RawEvent[]
  trigger: string
  callers: string[]
}

export interface IncidentListed {
  ref: string
  trigger: string
  agent: string
  ageMs: number
}

export interface IncidentTotals {
  sinceMin: number
  counts: Record<string, number>
}

export interface IncidentTimeline {
  begin: (paneId: string | undefined, method: string, caller?: string) => IncidentCall
  state: (paneId: string, to: string, from?: string) => void
  hook: (paneId: string, ok: boolean, code?: string) => void
  mail: (paneId: string, code: string, age: number) => void
  wake: (paneId: string, code: string, ms: number) => void
  forget: (paneId: string) => void
  list: (periodMs: number) => IncidentListed[]
  take: (ref: string) => IncidentTake | undefined
  totals: () => IncidentTotals
  clear: () => void
}

interface Kept {
  id: string
  paneId: string
  agent: string
  trigger: string
  at: number
  sourceAt: number
  events: RawEvent[]
}

const code = (value: string, fallback: string): string => (CODE.test(value) ? value : fallback)

export function createIncidentTimeline(deps: IncidentTimelineDeps): IncidentTimeline {
  const rings = new Map<string, RawEvent[]>()
  const open = new Set<Open>()
  const kept: Kept[] = []
  const totals = new Map<string, number>()
  const startedAt = deps.now()
  let keptSeq = 0

  const prune = (ring: RawEvent[], now: number): void => {
    while (ring.length > 0 && now - (ring[0]?.at ?? now) > INCIDENT_WINDOW_MS) ring.shift()
    while (ring.length > INCIDENT_EVENTS_MAX) ring.shift()
  }

  interface Found {
    code: string
    at: number
  }

  const specificOf = (ring: RawEvent[]): Found | undefined => {
    for (let i = ring.length - 1; i >= 0; i--) {
      const event = ring[i]
      if (!event) continue
      if (event.k === 'mail' || event.k === 'wake') return { code: event.code, at: event.at }
      if (event.k === 'hook' && !event.ok) {
        return { code: event.code ?? 'hook-failed', at: event.at }
      }
      if (event.k === 'call' && event.phase === 'end' && event.code) {
        return { code: event.code, at: event.at }
      }
    }
    return undefined
  }

  const slowOf = (ring: RawEvent[]): Found | undefined => {
    for (let i = ring.length - 1; i >= 0; i--) {
      const event = ring[i]
      if (event?.k !== 'call') continue
      if (event.phase === 'end' && (event.ms ?? 0) >= INCIDENT_STALL_MS) {
        return { code: 'slow-call', at: event.at }
      }
      if (event.phase === 'cancel') return { code: 'call-cancelled', at: event.at }
    }
    return undefined
  }

  const stalledOpen = (paneId: string, now: number): boolean => {
    for (const call of open) {
      if (call.paneId === paneId && now - call.began >= INCIDENT_STALL_MS) return true
    }
    return false
  }

  const triggerOf = (paneId: string, ring: RawEvent[], now: number): string | undefined =>
    specificOf(ring)?.code ?? (stalledOpen(paneId, now) ? 'call-open' : slowOf(ring)?.code)

  const callersOf = (events: RawEvent[]): string[] => [
    ...new Set(events.flatMap((e) => (e.k === 'call' && e.from ? [e.from] : []))),
  ]

  const freeze = (paneId: string, ring: RawEvent[], now: number): void => {
    const found = specificOf(ring) ?? slowOf(ring)
    if (!found) return
    const events = ring.map((e) => ({ ...e }))
    const last = kept.at(-1)
    if (last && last.paneId === paneId && now - last.at < MERGE_MS) {
      last.trigger = found.code
      last.at = now
      last.sourceAt = Math.max(last.sourceAt, found.at)
      last.events = events
      return
    }
    if (kept.some((entry) => entry.paneId === paneId && entry.sourceAt >= found.at)) return
    while (kept.length > 0 && now - (kept[0]?.at ?? now) > INCIDENT_KEEP_MS) kept.shift()
    while (kept.length >= INCIDENT_KEPT_MAX) kept.shift()
    const entry: Kept = {
      id: `i${++keptSeq}`,
      paneId,
      agent: 'other',
      trigger: found.code,
      at: now,
      sourceAt: found.at,
      events,
    }
    kept.push(entry)
    void deps
      .snapshot(paneId)
      .then((snap) => {
        if (snap) entry.agent = snap.agent
      })
      .catch(() => {})
  }

  const push = (paneId: string, event: RawEvent): void => {
    let ring = rings.get(paneId)
    if (!ring) {
      if (rings.size >= INCIDENT_PANES_MAX) {
        const oldest = rings.keys().next().value
        if (oldest !== undefined) rings.delete(oldest)
      }
      ring = []
      rings.set(paneId, ring)
    }
    ring.push(event)
    prune(ring, event.at)
    if (event.k !== 'state') freeze(paneId, ring, event.at)
  }

  const count = (method: string, result: string | undefined): void => {
    const key = `${method}.${result ?? 'ok'}`
    if (!totals.has(key) && totals.size >= TOTALS_KEYS_MAX) return
    totals.set(key, (totals.get(key) ?? 0) + 1)
  }

  return {
    begin: (target, method, caller) => {
      const began = deps.now()
      const name = METHOD.test(method) ? method : 'other'
      const call: Open = { paneId: target ?? '', method: name, caller, began }
      const attach = (paneId: string): void => {
        call.paneId = paneId
        open.add(call)
        const start: RawEvent = {
          k: 'call',
          at: began,
          method: name,
          phase: 'start',
          ...(caller ? { from: caller } : {}),
        }
        push(paneId, start)
        void deps
          .snapshot(paneId)
          .then((before) => {
            if (before && start.k === 'call') start.before = before
          })
          .catch(() => {})
      }
      if (target) attach(target)
      const finish = (phase: 'end' | 'cancel', result?: string): void => {
        const bound = open.delete(call)
        count(name, phase === 'cancel' ? 'cancelled' : result ? code(result, 'error') : undefined)
        if (!bound) return
        const at = deps.now()
        const done: RawEvent = {
          k: 'call',
          at,
          method: name,
          phase,
          ms: Math.round(at - began),
          ...(caller ? { from: caller } : {}),
          ...(result ? { code: code(result, 'error') } : {}),
        }
        push(call.paneId, done)
        void deps
          .snapshot(call.paneId)
          .then((after) => {
            if (after && done.k === 'call') done.after = after
          })
          .catch(() => {})
      }
      return {
        bind: (paneId) => {
          if (!call.paneId) attach(paneId)
        },
        phase: (phaseName) => {
          if (!open.has(call)) return
          push(call.paneId, {
            k: 'call',
            at: deps.now(),
            method: name,
            phase: 'phase',
            name: code(phaseName, 'other'),
            ms: Math.round(deps.now() - began),
          })
        },
        end: (result) => finish('end', result),
        cancel: () => finish('cancel'),
      }
    },
    state: (paneId, to, from) =>
      push(paneId, {
        k: 'state',
        at: deps.now(),
        to: code(to, 'other'),
        ...(from ? { from: code(from, 'other') } : {}),
      }),
    hook: (paneId, ok, result) =>
      push(paneId, {
        k: 'hook',
        at: deps.now(),
        ok,
        ...(result ? { code: code(result, 'other') } : {}),
      }),
    mail: (paneId, result, age) =>
      push(paneId, {
        k: 'mail',
        at: deps.now(),
        code: code(result, 'other'),
        age: Math.round(age),
      }),
    wake: (paneId, result, ms) =>
      push(paneId, { k: 'wake', at: deps.now(), code: code(result, 'other'), ms: Math.round(ms) }),
    forget: (paneId) => {
      rings.delete(paneId)
      for (const call of open) if (call.paneId === paneId) open.delete(call)
    },
    list: (periodMs) => {
      const now = deps.now()
      const out: IncidentListed[] = kept
        .filter((entry) => now - entry.at <= periodMs)
        .map((entry) => ({
          ref: entry.id,
          trigger: entry.trigger,
          agent: entry.agent,
          ageMs: now - entry.at,
        }))
      for (const [paneId, ring] of rings) {
        prune(ring, now)
        if (stalledOpen(paneId, now) && !specificOf(ring)) {
          out.push({ ref: paneId, trigger: 'call-open', agent: 'other', ageMs: 0 })
        }
      }
      return out.sort((a, b) => a.ageMs - b.ageMs)
    },
    take: (ref) => {
      const now = deps.now()
      const frozen = kept.find((entry) => entry.id === ref)
      if (frozen) {
        return {
          paneId: frozen.paneId,
          agent: frozen.agent,
          events: frozen.events.map((e) => ({ ...e })),
          trigger: frozen.trigger,
          callers: callersOf(frozen.events),
        }
      }
      const ring = rings.get(ref)
      if (!ring) return undefined
      prune(ring, now)
      const events: RawEvent[] = ring.map((e) => ({ ...e }))
      for (const call of open) {
        if (call.paneId === ref && now - call.began >= INCIDENT_STALL_MS) {
          events.push({
            k: 'call',
            at: now,
            method: call.method,
            phase: 'phase',
            name: 'never-returned',
            ms: Math.round(now - call.began),
            ...(call.caller ? { from: call.caller } : {}),
          })
        }
      }
      return {
        paneId: ref,
        agent: 'other',
        events,
        trigger: triggerOf(ref, ring, now) ?? 'manual',
        callers: callersOf(events),
      }
    },
    totals: () => ({
      sinceMin: Math.floor((deps.now() - startedAt) / 60_000),
      counts: Object.fromEntries(totals),
    }),
    clear: () => {
      rings.clear()
      open.clear()
      kept.length = 0
      totals.clear()
    },
  }
}
