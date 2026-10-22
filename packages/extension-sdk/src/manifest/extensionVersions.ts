import semver from 'semver'
import { apiProblem, parseApiVersion } from '../contract/extensionApi'

export interface ReleaseCandidate {
  version: string
  api: string
}

export function isPrerelease(version: string): boolean {
  return semver.prerelease(version) !== null
}

export function isNewerVersion(candidate: string, installed: string): boolean {
  if (semver.valid(candidate) && semver.valid(installed)) return semver.gt(candidate, installed)
  return candidate !== installed
}

export function isOlderVersion(candidate: string, installed: string): boolean {
  return (
    Boolean(semver.valid(candidate) && semver.valid(installed)) && semver.lt(candidate, installed)
  )
}

function byNewest(a: ReleaseCandidate, b: ReleaseCandidate): number {
  if (semver.valid(a.version) && semver.valid(b.version))
    return semver.rcompare(a.version, b.version)
  return b.version.localeCompare(a.version)
}

export function newestCompatible<T extends ReleaseCandidate>(
  releases: readonly T[],
  appApi: string,
  allowPrerelease: boolean,
): T | null {
  const usable = releases
    .filter((release) => apiProblem(release.api, appApi) === null)
    .filter((release) => allowPrerelease || !isPrerelease(release.version))
  return [...usable].sort(byNewest)[0] ?? null
}

export function lowestApiNeeded(releases: readonly ReleaseCandidate[]): string | null {
  const parsed = releases.flatMap((release) => {
    const api = parseApiVersion(release.api)
    return api ? [{ api: release.api, ...api }] : []
  })
  parsed.sort((a, b) => a.major - b.major || a.minor - b.minor)
  return parsed[0]?.api ?? null
}
