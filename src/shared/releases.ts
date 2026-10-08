export const RELEASE_REPOSITORY = { owner: 'aurigax-ai', name: 'ostia' } as const

export const RELEASE_API_BASE_URL = 'https://api.github.com'

export const UPDATE_CHANNELS = ['stable', 'main'] as const

export type UpdateChannel = (typeof UPDATE_CHANNELS)[number]

export const DEFAULT_UPDATE_CHANNEL: UpdateChannel = 'stable'

const MAIN_CHANNEL_PRERELEASES = ['main', 'rc'] as const

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

const isNumeric = (part: string): boolean => /^\d+$/.test(part)

function comparePrereleasePart(a: string, b: string): number {
  const numeric = isNumeric(a)
  if (numeric !== isNumeric(b)) return numeric ? -1 : 1
  if (numeric && a.length !== b.length) return a.length - b.length
  return a < b ? -1 : a > b ? 1 : 0
}

function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return b.length - a.length
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const order = comparePrereleasePart(a[i], b[i])
    if (order !== 0) return order
  }
  return a.length - b.length
}

export function compareVersions(a: Version, b: Version): number {
  return Math.sign(
    a.major - b.major ||
      a.minor - b.minor ||
      a.patch - b.patch ||
      comparePrerelease(a.prerelease, b.prerelease),
  )
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

interface ParsedEntry {
  text: string
  version: Version
  url: string
  stable: boolean
  draft: boolean
  flagged: boolean
}

function parseEntry(raw: unknown): ParsedEntry | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { tag_name: tag, html_url: page, draft, prerelease } = raw as Record<string, unknown>
  if (typeof tag !== 'string' || typeof draft !== 'boolean' || typeof prerelease !== 'boolean') {
    return null
  }
  const text = tag.startsWith('v') ? tag.slice(1) : tag
  const version = parseVersion(text)
  if (!version) return null
  const url = releasePageUrl(page, tag)
  if (!url) return null
  const plain = version.prerelease.length === 0 && !text.includes('+')
  return { text, version, url, stable: plain && !prerelease, draft, flagged: prerelease }
}

export function isMainChannelVersion(version: Version): boolean {
  const [kind, number, ...rest] = version.prerelease
  return (
    rest.length === 0 &&
    (MAIN_CHANNEL_PRERELEASES as readonly string[]).includes(kind) &&
    number !== undefined &&
    isNumeric(number)
  )
}

export function parseLatestRelease(raw: unknown): ParsedRelease {
  const entry = parseEntry(raw)
  if (!entry) return { ok: false, reason: 'malformed' }
  if (entry.draft || !entry.stable) return { ok: false, reason: 'not-stable' }
  return { ok: true, release: { version: entry.text, url: entry.url } }
}

function offeredOnMain(entry: ParsedEntry): boolean {
  if (entry.draft) return false
  if (entry.stable) return true
  return entry.flagged && !entry.text.includes('+') && isMainChannelVersion(entry.version)
}

export function pickMainChannelRelease(raw: unknown): ParsedRelease {
  if (!Array.isArray(raw)) return { ok: false, reason: 'malformed' }
  let best: ParsedEntry | null = null
  for (const item of raw) {
    const entry = parseEntry(item)
    if (!entry || !offeredOnMain(entry)) continue
    if (!best || compareVersions(entry.version, best.version) > 0) best = entry
  }
  return best
    ? { ok: true, release: { version: best.text, url: best.url } }
    : { ok: false, reason: 'not-stable' }
}

export function parseUpdateChannel(raw: unknown): UpdateChannel {
  return raw === 'main' ? 'main' : DEFAULT_UPDATE_CHANNEL
}
