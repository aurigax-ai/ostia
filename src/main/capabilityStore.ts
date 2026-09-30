import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { ALL_CAPABILITIES, type Capability, DEFAULT_CAPABILITIES } from '../shared/capabilities'

const grants = new Map<string, Set<Capability>>()

let grantedCapsCache: Capability[] | null = null

export function loadGrantedCaps(): Capability[] {
  if (grantedCapsCache) return grantedCapsCache
  grantedCapsCache = readGrantedCapsFromDisk()
  return grantedCapsCache
}

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

export function initCaps(externalId: string): Set<Capability> {
  let set = grants.get(externalId)
  if (!set) {
    set = new Set([...DEFAULT_CAPABILITIES, ...loadGrantedCaps()])
    grants.set(externalId, set)
  }
  return set
}

export function setCaps(externalId: string, caps: readonly Capability[]): void {
  grants.set(externalId, new Set(caps))
}

export function grant(externalId: string, cap: Capability): void {
  initCaps(externalId).add(cap)
}

export function hasCap(externalId: string, cap: Capability): boolean {
  return grants.get(externalId)?.has(cap) ?? false
}

export function dropIdentity(externalId: string): void {
  grants.delete(externalId)
}

export function revoke(externalId: string, cap: Capability): void {
  grants.get(externalId)?.delete(cap)
}
