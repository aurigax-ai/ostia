/**
 * Per-externalId capability grants (spec §6, §6.1). Pure module — no Electron
 * import — so it's unit-tested in a plain node env. Consulted by the Slice 4
 * control-socket broker (`controlAuth`) to gate privileged actions.
 */
import { type Capability, DEFAULT_CAPABILITIES } from '../shared/capabilities'

const grants = new Map<string, Set<Capability>>() // key: externalId

/** Ensure an identity has (at least) the default caps; returns its cap set. */
export function initCaps(externalId: string): Set<Capability> {
  let set = grants.get(externalId)
  if (!set) {
    set = new Set(DEFAULT_CAPABILITIES)
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
