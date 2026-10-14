import { PRODUCT_NAME } from '../product'

export const RELEASE_REPOSITORY = { owner: 'aurigax-ai', name: 'ostia' } as const

export const RELEASE_API_BASE_URL = 'https://api.github.com'

export const UPDATE_CHANNELS = ['stable', 'beta', 'main'] as const

export type UpdateChannel = (typeof UPDATE_CHANNELS)[number]

export const DEFAULT_UPDATE_CHANNEL: UpdateChannel = 'stable'

const MAIN_CHANNEL_PRERELEASES = ['main', 'rc'] as const

const BETA_CHANNEL_PRERELEASES = ['rc'] as const

const SHA256_DIGEST = /^sha256:([0-9a-f]{64})$/

export interface Version {
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

export interface ReleaseInfo {
  version: string
  url: string
  dmgSha256?: string
}

export function dmgAssetName(version: string): string {
  return `${PRODUCT_NAME}-${version}-arm64.dmg`
}

export function tarballAssetName(version: string): string {
  return `${PRODUCT_NAME}-${version}-linux-x64.tar.gz`
}

export type AssetName = (version: string) => string

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

function releasePageUrl(raw: unknown, tag: string): string | null {
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
  dmg: { sha256: string | null } | null
  assetNames: string[]
}

function assetNames(assets: unknown): string[] {
  if (!Array.isArray(assets)) return []
  return assets.flatMap((asset) => {
    const name = typeof asset === 'object' && asset !== null ? asset.name : undefined
    return typeof name === 'string' ? [name] : []
  })
}

function dmgAsset(assets: unknown, text: string): ParsedEntry['dmg'] {
  if (!Array.isArray(assets)) return null
  const name = dmgAssetName(text)
  for (const asset of assets) {
    if (typeof asset !== 'object' || asset === null) continue
    const { name: assetName, digest } = asset as Record<string, unknown>
    if (assetName !== name) continue
    const match = typeof digest === 'string' ? SHA256_DIGEST.exec(digest) : null
    return { sha256: match ? match[1] : null }
  }
  return null
}

function releaseInfo(entry: ParsedEntry): ReleaseInfo {
  const info: ReleaseInfo = { version: entry.text, url: entry.url }
  if (entry.dmg?.sha256) info.dmgSha256 = entry.dmg.sha256
  return info
}

function parseEntry(raw: unknown): ParsedEntry | null {
  if (typeof raw !== 'object' || raw === null) return null
  const {
    tag_name: tag,
    html_url: page,
    draft,
    prerelease,
    assets,
  } = raw as Record<string, unknown>
  if (typeof tag !== 'string' || typeof draft !== 'boolean' || typeof prerelease !== 'boolean') {
    return null
  }
  const text = tag.startsWith('v') ? tag.slice(1) : tag
  const version = parseVersion(text)
  if (!version) return null
  const url = releasePageUrl(page, tag)
  if (!url) return null
  const plain = version.prerelease.length === 0 && !text.includes('+')
  return {
    text,
    version,
    url,
    stable: plain && !prerelease,
    draft,
    flagged: prerelease,
    dmg: dmgAsset(assets, text),
    assetNames: assetNames(assets),
  }
}

function isNumberedPrerelease(version: Version, kinds: readonly string[]): boolean {
  const [kind, number, ...rest] = version.prerelease
  return rest.length === 0 && kinds.includes(kind) && number !== undefined && isNumeric(number)
}

export function isMainChannelVersion(version: Version): boolean {
  return isNumberedPrerelease(version, MAIN_CHANNEL_PRERELEASES)
}

function isBetaChannelVersion(version: Version): boolean {
  return isNumberedPrerelease(version, BETA_CHANNEL_PRERELEASES)
}

export function parseLatestRelease(raw: unknown): ParsedRelease {
  const entry = parseEntry(raw)
  if (!entry) return { ok: false, reason: 'malformed' }
  if (entry.draft || !entry.stable) return { ok: false, reason: 'not-stable' }
  return { ok: true, release: releaseInfo(entry) }
}

function offeredOnMain(entry: ParsedEntry): boolean {
  if (entry.draft) return false
  if (entry.stable) return true
  return entry.flagged && !entry.text.includes('+') && isMainChannelVersion(entry.version)
}

function offeredOnBeta(entry: ParsedEntry, asset: AssetName): boolean {
  if (entry.draft || !entry.assetNames.includes(asset(entry.text))) return false
  if (entry.stable) return true
  return entry.flagged && !entry.text.includes('+') && isBetaChannelVersion(entry.version)
}

function pickHighest(raw: unknown, offered: (entry: ParsedEntry) => boolean): ParsedRelease {
  if (!Array.isArray(raw)) return { ok: false, reason: 'malformed' }
  let best: ParsedEntry | null = null
  for (const item of raw) {
    const entry = parseEntry(item)
    if (!entry || !offered(entry)) continue
    if (!best || compareVersions(entry.version, best.version) > 0) best = entry
  }
  return best ? { ok: true, release: releaseInfo(best) } : { ok: false, reason: 'not-stable' }
}

export function pickMainChannelRelease(raw: unknown): ParsedRelease {
  return pickHighest(raw, offeredOnMain)
}

export function pickBetaRelease(raw: unknown, asset: AssetName = dmgAssetName): ParsedRelease {
  return pickHighest(raw, (entry) => offeredOnBeta(entry, asset))
}

export function parseUpdateChannel(raw: unknown): UpdateChannel {
  return raw === 'main' || raw === 'beta' ? raw : DEFAULT_UPDATE_CHANNEL
}
