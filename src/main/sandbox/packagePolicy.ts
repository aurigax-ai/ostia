import { type PackageRef, packageKey, packageVersionKey } from '../../shared/packages'

export interface PackagePolicy {
  malware: boolean
  cooldownDays: number
  denyList: readonly string[]
  allowOnly: readonly string[] | null
  allowances: readonly string[]
}

export type MalwareCheck = 'clean' | 'malicious' | 'unavailable'

export interface PackageLookups {
  malware: (pkg: PackageRef) => Promise<MalwareCheck>
  publishedAt: (pkg: PackageRef) => Promise<number | null>
}

export type PackageBlockReason =
  | 'deny-list'
  | 'not-allowed'
  | 'malware'
  | 'osv-unavailable'
  | 'cooldown'

export type PackageDecision = { allow: true } | { allow: false; reason: PackageBlockReason }

const DAY_MS = 24 * 3600_000

export async function decidePackage(
  pkg: PackageRef,
  policy: PackagePolicy,
  lookups: PackageLookups,
  now: number,
): Promise<PackageDecision> {
  const key = packageKey(pkg)
  if (policy.denyList.includes(key)) return { allow: false, reason: 'deny-list' }
  if (policy.allowOnly && !policy.allowOnly.includes(key))
    return { allow: false, reason: 'not-allowed' }
  const allowed = policy.allowances.includes(packageVersionKey(pkg))
  if (policy.malware) {
    const check = await lookups.malware(pkg)
    if (check === 'malicious') return { allow: false, reason: 'malware' }
    if (check === 'unavailable' && !allowed) return { allow: false, reason: 'osv-unavailable' }
  }
  if (allowed) return { allow: true }
  if (policy.cooldownDays > 0) {
    const published = await lookups.publishedAt(pkg)
    if (published !== null && now - published < policy.cooldownDays * DAY_MS) {
      return { allow: false, reason: 'cooldown' }
    }
  }
  return { allow: true }
}
