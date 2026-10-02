import { compare } from 'semver'

export const RELEASE_REPOSITORY = { owner: 'aurigax-ai', name: 'pine' } as const

export const RELEASE_API_BASE_URL = 'https://api.github.com'

export interface Version {
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

export interface ReleaseInfo {
  version: string
  url: string
}

export type ReleaseCheckError = 'offline' | 'rate-limited' | 'unavailable'

export type ReleaseCheckResult =
  | { status: 'latest'; version: string }
  | { status: 'available'; release: ReleaseInfo }
  | { status: 'error'; error: ReleaseCheckError }

export type ParsedRelease =
  | { ok: true; release: ReleaseInfo }
  | { ok: false; reason: 'not-stable' | 'malformed' }

const VERSION_PATTERN =
  /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const VERSION_MAX_CHARS = 64

export function parseVersion(text: unknown): Version | null {
  if (typeof text !== 'string' || text.length > VERSION_MAX_CHARS) return null
  const match = VERSION_PATTERN.exec(text)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

function versionToString(v: Version): string {
  const base = `${v.major}.${v.minor}.${v.patch}`
  return v.prerelease.length > 0 ? `${base}-${v.prerelease.join('.')}` : base
}

export function compareVersions(a: Version, b: Version): number {
  return compare(versionToString(a), versionToString(b))
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate)
  const b = parseVersion(current)
  return Boolean(a && b && compareVersions(a, b) > 0)
}

export function releasePageUrl(raw: unknown, tag: string): string | null {
  if (typeof raw !== 'string') return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const { owner, name } = RELEASE_REPOSITORY
  const trusted =
    url.protocol === 'https:' &&
    url.host === 'github.com' &&
    url.username === '' &&
    url.password === '' &&
    url.search === '' &&
    url.hash === '' &&
    url.pathname === `/${owner}/${name}/releases/tag/${tag}`
  return trusted ? url.href : null
}

export function parseLatestRelease(raw: unknown): ParsedRelease {
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'malformed' }
  const { tag_name: tag, html_url: page, draft, prerelease } = raw as Record<string, unknown>
  if (typeof tag !== 'string' || typeof draft !== 'boolean' || typeof prerelease !== 'boolean') {
    return { ok: false, reason: 'malformed' }
  }
  const text = tag.startsWith('v') ? tag.slice(1) : tag
  const version = parseVersion(text)
  if (!version) return { ok: false, reason: 'malformed' }
  const url = releasePageUrl(page, tag)
  if (!url) return { ok: false, reason: 'malformed' }
  if (draft || prerelease || version.prerelease.length > 0 || text.includes('+')) {
    return { ok: false, reason: 'not-stable' }
  }
  return { ok: true, release: { version: text, url } }
}
