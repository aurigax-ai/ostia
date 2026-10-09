import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { ALL_CAPABILITIES, type Capability, DEFAULT_CAPABILITIES } from '../../shared/capabilities'
import { ALWAYS_ASK } from '../../shared/permissions/approvals'
import { type ReachMode, isReachMode, parseReachMode } from '../../shared/permissions/reach'

const grants = new Map<string, Set<Capability>>()
const followsSettings = new Set<string>()

let grantedCapsCache: Capability[] | null = null
let reachModeCache: ReachMode | null = null

function settingsFile(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function loadGrantedCaps(): Capability[] {
  if (grantedCapsCache) return grantedCapsCache
  grantedCapsCache = readGrantedCapsFromDisk()
  return grantedCapsCache
}

function grantsOf(settings: unknown): Capability[] {
  const raw = (settings as { capabilities?: { grants?: unknown } } | null)?.capabilities?.grants
  if (!Array.isArray(raw)) return []
  return raw.filter((cap): cap is Capability => ALL_CAPABILITIES.includes(cap as Capability))
}

function readSettingsFromDisk(): unknown {
  try {
    const path = settingsFile()
    if (!existsSync(path)) return undefined
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

function readGrantedCapsFromDisk(): Capability[] {
  return grantsOf(readSettingsFromDisk())
}

function reachOf(settings: unknown): ReachMode {
  return parseReachMode(
    (settings as { capabilities?: { reach?: unknown } } | null | undefined)?.capabilities?.reach,
  )
}

export function loadReachMode(): ReachMode {
  reachModeCache ??= reachOf(readSettingsFromDisk())
  return reachModeCache
}

function applyGrantedCaps(next: readonly Capability[]): void {
  const before = loadGrantedCaps()
  grantedCapsCache = [...new Set(next)]
  const added = grantedCapsCache.filter((cap) => !before.includes(cap))
  const removed = before.filter(
    (cap) => !grantedCapsCache?.includes(cap) && !DEFAULT_CAPABILITIES.includes(cap),
  )
  for (const externalId of followsSettings) {
    const set = grants.get(externalId)
    if (!set) continue
    for (const cap of added) set.add(cap)
    for (const cap of removed) set.delete(cap)
  }
}

export function refreshCapabilitySettings(): void {
  const settings = readSettingsFromDisk()
  applyGrantedCaps(grantsOf(settings))
  reachModeCache = reachOf(settings)
}

function writeCapabilities(change: (record: Record<string, unknown>) => void): boolean {
  try {
    const path = settingsFile()
    const settings: unknown = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
    if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return false
    const record = settings as Record<string, unknown>
    const capabilities = record.capabilities
    const next: Record<string, unknown> = {
      ...(typeof capabilities === 'object' && capabilities !== null ? capabilities : {}),
    }
    change(next)
    record.capabilities = next
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

function writeGrantedCaps(change: (current: Capability[]) => Capability[]): boolean {
  let next: Capability[] = []
  const written = writeCapabilities((capabilities) => {
    next = change(grantsOf({ capabilities }))
    capabilities.grants = next
  })
  if (written) applyGrantedCaps(next)
  return written
}

export function setReachMode(mode: unknown): boolean {
  if (!isReachMode(mode)) return false
  const written = writeCapabilities((capabilities) => {
    capabilities.reach = mode
  })
  if (written) reachModeCache = mode
  return written
}

export function addStandingGrants(caps: readonly Capability[]): boolean {
  if (caps.some((cap) => ALWAYS_ASK.includes(cap) || !ALL_CAPABILITIES.includes(cap))) return false
  return writeGrantedCaps((current) => [...new Set([...current, ...caps])])
}

export function removeStandingGrant(cap: Capability): boolean {
  return writeGrantedCaps((current) => current.filter((c) => c !== cap))
}

export function initCaps(externalId: string): Set<Capability> {
  let set = grants.get(externalId)
  if (!set) {
    set = new Set([...DEFAULT_CAPABILITIES, ...loadGrantedCaps()])
    grants.set(externalId, set)
    followsSettings.add(externalId)
  }
  return set
}

export function setCaps(externalId: string, caps: readonly Capability[]): void {
  grants.set(externalId, new Set(caps))
  followsSettings.delete(externalId)
}

export function grant(externalId: string, cap: Capability): void {
  initCaps(externalId).add(cap)
}

export function hasCap(externalId: string, cap: Capability): boolean {
  return grants.get(externalId)?.has(cap) ?? false
}

export function dropIdentity(externalId: string): void {
  grants.delete(externalId)
  followsSettings.delete(externalId)
}

export function revoke(externalId: string, cap: Capability): void {
  grants.get(externalId)?.delete(cap)
}
