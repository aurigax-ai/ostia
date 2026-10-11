import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import type {
  ScriptTokenCall,
  ScriptTokenCallOutcome,
  ScriptTokenCallTarget,
  ScriptTokenUsage,
} from '../../shared/permissions/scriptTokens'
import { loadJson, saveJson } from '../platform/jsonStore'
import type { ReachListing } from './reach'

export const USAGE_KEEP = 100
const HOUR_MS = 3_600_000
const HOURS = 24
const FLUSH_MS = 5_000

interface Ring {
  calls: (ScriptTokenCall | undefined)[]
  start: number
  size: number
  hours: [hour: number, calls: number, refused: number][]
}

interface StoredUsage {
  calls: ScriptTokenCall[]
  hours: [number, number, number][]
}

const OUTCOMES: readonly ScriptTokenCallOutcome[] = [
  'ok',
  'out-of-scope',
  'missing-permission',
  'error',
  'regenerated',
]

function refused(outcome: ScriptTokenCallOutcome): boolean {
  return outcome === 'out-of-scope' || outcome === 'missing-permission'
}

function emptyRing(): Ring {
  return { calls: new Array(USAGE_KEEP), start: 0, size: 0, hours: [] }
}

function push(ring: Ring, call: ScriptTokenCall): void {
  ring.calls[(ring.start + ring.size) % USAGE_KEEP] = call
  if (ring.size < USAGE_KEEP) ring.size += 1
  else ring.start = (ring.start + 1) % USAGE_KEEP
}

function ordered(ring: Ring): ScriptTokenCall[] {
  const out: ScriptTokenCall[] = []
  for (let i = 0; i < ring.size; i++) {
    const call = ring.calls[(ring.start + i) % USAGE_KEEP]
    if (call) out.push(call)
  }
  return out
}

function count(ring: Ring, at: number, outcome: ScriptTokenCallOutcome): void {
  if (outcome === 'regenerated') return
  const hour = Math.floor(at / HOUR_MS)
  const slot = hour % HOURS
  const bucket = ring.hours[slot]
  if (!bucket || bucket[0] !== hour) ring.hours[slot] = [hour, 0, 0]
  const live = ring.hours[slot]
  live[1] += 1
  if (refused(outcome)) live[2] += 1
}

function storedCall(raw: unknown): ScriptTokenCall | undefined {
  const c = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  if (typeof c.at !== 'string' || Number.isNaN(Date.parse(c.at))) return undefined
  if (typeof c.method !== 'string' || !OUTCOMES.includes(c.outcome as ScriptTokenCallOutcome)) {
    return undefined
  }
  const t =
    typeof c.target === 'object' && c.target !== null ? (c.target as ScriptTokenCallTarget) : {}
  const target: ScriptTokenCallTarget = {}
  if (typeof t.workspaceId === 'string') target.workspaceId = t.workspaceId
  if (typeof t.paneId === 'string') target.paneId = t.paneId
  return {
    at: c.at,
    method: c.method,
    target,
    outcome: c.outcome as ScriptTokenCallOutcome,
    ...(typeof c.code === 'string' ? { code: c.code } : {}),
  }
}

function loadRings(path: string): Map<string, Ring> {
  const raw = loadJson<Record<string, Partial<StoredUsage>>>(path, {})
  const rings = new Map<string, Ring>()
  for (const [id, stored] of Object.entries(raw ?? {})) {
    const ring = emptyRing()
    const calls = Array.isArray(stored?.calls) ? stored.calls : []
    for (const call of calls.slice(-USAGE_KEEP)) {
      const clean = storedCall(call)
      if (clean) push(ring, clean)
    }
    for (const h of Array.isArray(stored?.hours) ? stored.hours : []) {
      if (Array.isArray(h) && h.length === 3 && h.every(Number.isInteger)) {
        ring.hours[h[0] % HOURS] = [h[0], h[1], h[2]]
      }
    }
    rings.set(id, ring)
  }
  return rings
}

export interface ConnectionSource {
  pid?: number
}

export interface ScriptTokenUsageLog {
  record: (
    tokenId: string,
    call: {
      method: string
      target: ScriptTokenCallTarget
      outcome: ScriptTokenCallOutcome
      code?: string
    },
  ) => void
  regenerated: (tokenId: string) => void
  connected: (tokenId: string, source: ConnectionSource) => () => void
  clear: (tokenId: string) => void
  usage: (tokenId: string) => Omit<ScriptTokenUsage, 'names'>
  flush: () => void
}

export interface UsageLogOptions {
  now?: () => number
  flushMs?: number
}

export function createScriptTokenUsage(
  path: () => string,
  options: UsageLogOptions = {},
): ScriptTokenUsageLog {
  const now = options.now ?? Date.now
  const flushMs = options.flushMs ?? FLUSH_MS
  const connections = new Map<string, Map<object, ConnectionSource>>()
  let rings: Map<string, Ring> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const loaded = (): Map<string, Ring> => {
    rings ??= loadRings(path())
    return rings
  }

  const flush = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    if (!rings) return
    const out: Record<string, StoredUsage> = {}
    for (const [id, ring] of rings) {
      out[id] = { calls: ordered(ring), hours: ring.hours.filter(Boolean) }
    }
    saveJson(path(), out, { secure: true })
  }

  const later = (): void => {
    if (timer) return
    timer = setTimeout(flush, flushMs)
    timer.unref?.()
  }

  const add = (tokenId: string, call: ScriptTokenCall, at: number): void => {
    const all = loaded()
    let ring = all.get(tokenId)
    if (!ring) {
      ring = emptyRing()
      all.set(tokenId, ring)
    }
    push(ring, call)
    count(ring, at, call.outcome)
    later()
  }

  return {
    record: (tokenId, call) => {
      const at = now()
      add(
        tokenId,
        {
          at: new Date(at).toISOString(),
          method: call.method,
          target: call.target,
          outcome: call.outcome,
          ...(call.code ? { code: call.code } : {}),
        },
        at,
      )
    },
    regenerated: (tokenId) => {
      connections.delete(tokenId)
      const at = now()
      add(
        tokenId,
        { at: new Date(at).toISOString(), method: '', target: {}, outcome: 'regenerated' },
        at,
      )
    },
    connected: (tokenId, source) => {
      const key = {}
      let open = connections.get(tokenId)
      if (!open) {
        open = new Map()
        connections.set(tokenId, open)
      }
      open.set(key, source)
      return () => {
        const still = connections.get(tokenId)
        still?.delete(key)
        if (still?.size === 0) connections.delete(tokenId)
      }
    },
    clear: (tokenId) => {
      connections.delete(tokenId)
      if (loaded().delete(tokenId)) later()
    },
    usage: (tokenId) => {
      const ring = loaded().get(tokenId)
      const since = Math.floor(now() / HOUR_MS) - (HOURS - 1)
      let calls = 0
      let refusedCalls = 0
      for (const h of ring?.hours ?? []) {
        if (!h || h[0] < since) continue
        calls += h[1]
        refusedCalls += h[2]
      }
      const sources = [...(connections.get(tokenId)?.values() ?? [])]
      return {
        calls: ring ? ordered(ring).reverse() : [],
        connections: sources.map((s) => (s.pid ? { pid: s.pid } : {})),
        last24h: { calls, refused: refusedCalls },
      }
    },
    flush,
  }
}

export function programOf(pid: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'comm=', '-p', String(pid)], { timeout: 2_000 }, (err, out) => {
      const name = err ? '' : basename(String(out).trim())
      resolve(name || undefined)
    })
  })
}

export interface UsageLookups {
  listing: () => Promise<ReachListing>
  panes?: () => Promise<{ paneId: string; title: string }[]>
  program?: (pid: number) => Promise<string | undefined>
}

export async function usageView(
  log: ScriptTokenUsageLog,
  tokenId: string,
  lookups: UsageLookups,
): Promise<ScriptTokenUsage> {
  const usage = log.usage(tokenId)
  const workspaceIds = new Set(usage.calls.flatMap((c) => c.target.workspaceId ?? []))
  const paneIds = new Set(usage.calls.flatMap((c) => c.target.paneId ?? []))
  const [listing, panes, connections] = await Promise.all([
    workspaceIds.size > 0
      ? lookups.listing().catch((): ReachListing => ({ workspaces: [], groups: [] }))
      : { workspaces: [], groups: [] },
    paneIds.size > 0 && lookups.panes ? lookups.panes().catch(() => []) : [],
    Promise.all(
      usage.connections.map(async (c) => {
        const program = c.pid && lookups.program ? await lookups.program(c.pid) : undefined
        return program ? { ...c, program } : c
      }),
    ),
  ])
  const names: ScriptTokenUsage['names'] = { workspaces: {}, panes: {} }
  for (const w of listing.workspaces) {
    if (workspaceIds.has(w.workspaceId)) names.workspaces[w.workspaceId] = w.name
  }
  for (const p of panes) if (paneIds.has(p.paneId)) names.panes[p.paneId] = p.title
  return { ...usage, connections, names }
}
