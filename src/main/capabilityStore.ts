/**
 * Per-externalId capability grants (spec §6, §6.1). Consulted by the Slice 4
 * control-socket broker (`controlAuth`) to gate privileged actions.
 *
 * Elevated caps (not in DEFAULT_CAPABILITIES) can be granted to every pane up
 * front by a human editing `capabilities.grants` in settings.json — there's no
 * UI (and no `pine` verb) to self-grant, since `settings-write` is itself
 * elevated. `loadGrantedCaps` reads that array once per process (a restart
 * re-reads); it tolerates a missing/corrupt file or a not-yet-ready `app` by
 * falling back to `[]`, so this stays safe to import from a plain node test
 * env where Electron's `app` isn't available.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { ALL_CAPABILITIES, type Capability, DEFAULT_CAPABILITIES } from '../shared/capabilities'

const grants = new Map<string, Set<Capability>>() // key: externalId

let grantedCapsCache: Capability[] | null = null

/** Read `capabilities.grants` from settings.json. Cached for the process lifetime. */
export function loadGrantedCaps(): Capability[] {
  if (grantedCapsCache) return grantedCapsCache
  grantedCapsCache = readGrantedCapsFromDisk()
  return grantedCapsCache
}

/** Drop the cache so the next `loadGrantedCaps` call re-reads settings.json (tests only). */
export function resetGrantedCapsCache(): void {
  grantedCapsCache = null
}

function readGrantedCapsFromDisk(): Capability[] {
  try {
    const path = join(app.getPath('userData'), 'settings.json')
    if (!existsSync(path)) return []
    const settings = JSON.parse(readFileSync(path, 'utf8')) as {
      capabilities?: { grants?: unknown[] }
    }
    const raw = settings.capabilities?.grants
    if (!Array.isArray(raw)) return []
    return raw.filter((cap): cap is Capability => ALL_CAPABILITIES.includes(cap as Capability))
  } catch {
    return []
  }
}

/** Ensure an identity has (at least) the default + granted caps; returns its cap set. */
export function initCaps(externalId: string): Set<Capability> {
  let set = grants.get(externalId)
  if (!set) {
    set = new Set([...DEFAULT_CAPABILITIES, ...loadGrantedCaps()])
    grants.set(externalId, set)
  }
  return set
}

export function grant(externalId: string, cap: Capability): void {
  initCaps(externalId).add(cap)
}

export function revoke(externalId: string, cap: Capability): void {
  grants.get(externalId)?.delete(cap)
}

export function hasCap(externalId: string, cap: Capability): boolean {
  return grants.get(externalId)?.has(cap) ?? false
}

export function dropIdentity(externalId: string): void {
  grants.delete(externalId)
}
