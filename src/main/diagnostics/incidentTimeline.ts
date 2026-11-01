import { AsyncLocalStorage } from 'node:async_hooks'
import {
  INCIDENT_EVENTS_MAX,
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
  events: RawEvent[]
  trigger: string
  callers: string[]
}

export interface IncidentTimeline {
  begin: (paneId: string | undefined, method: string, caller?: string) => IncidentCall
  state: (paneId: string, to: string, from?: string) => void
  hook: (paneId: string, ok: boolean, code?: string) => void
  mail: (paneId: string, code: string, age: number) => void
  wake: (paneId: string, code: string, ms: number) => void
  forget: (paneId: string) => void
  list: () => { paneId: string; trigger: string; ageMs: number; events: number }[]
  take: (paneId: string) => IncidentTake | undefined
  clear: () => void
}

const code = (value: string, fallback: string): string => (CODE.test(value) ? value : fallback)

export function createIncidentTimeline(deps: IncidentTimelineDeps): IncidentTimeline {
  const rings = new Map<string, RawEvent[]>()
  const open = new Set<Open>()

  const prune = (ring: RawEvent[], now: number): void => {
    while (ring.length > 0 && now - (ring[0]?.at ?? now) > INCIDENT_WINDOW_MS) ring.shift()
    while (ring.length > INCIDENT_EVENTS_MAX) ring.shift()
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
  }

  const triggerOf = (paneId: string, ring: RawEvent[], now: number): string | undefined => {
    for (let i = ring.length - 1; i >= 0; i--) {
      const event = ring[i]
      if (!event) continue
      if (event.k === 'mail' || event.k === 'wake') return event.code
      if (event.k === 'hook' && !event.ok) return event.code ?? 'hook-failed'
      if (event.k === 'call' && event.phase === 'end' && event.code) return event.code
    }
    for (const call of open) {
      if (call.paneId === paneId && now - call.began >= INCIDENT_STALL_MS) return 'call-open'
    }
    for (let i = ring.length - 1; i >= 0; i--) {
      const event = ring[i]
      if (event?.k !== 'call') continue
      if (event.phase === 'end' && (event.ms ?? 0) >= INCIDENT_STALL_MS) return 'slow-call'
      if (event.phase === 'cancel') return 'call-cancelled'
    }
    return undefined
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
        if (!open.delete(call)) return
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
    list: () => {
      const now = deps.now()
      const out: { paneId: string; trigger: string; ageMs: number; events: number }[] = []
      for (const [paneId, ring] of rings) {
        prune(ring, now)
        const trigger = triggerOf(paneId, ring, now)
        if (trigger) {
          out.push({
            paneId,
            trigger,
            ageMs: now - (ring.at(-1)?.at ?? now),
            events: ring.length,
          })
        }
      }
      return out.sort((a, b) => a.ageMs - b.ageMs)
    },
    take: (paneId) => {
      const now = deps.now()
      const ring = rings.get(paneId)
      if (!ring) return undefined
      prune(ring, now)
      const events: RawEvent[] = ring.map((e) => ({ ...e }))
      for (const call of open) {
        if (call.paneId === paneId && now - call.began >= INCIDENT_STALL_MS) {
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
      const callers = [
        ...new Set(events.flatMap((e) => (e.k === 'call' && e.from ? [e.from] : []))),
      ]
      return { paneId, events, trigger: triggerOf(paneId, ring, now) ?? 'manual', callers }
    },
    clear: () => {
      rings.clear()
      open.clear()
    },
  }
}
