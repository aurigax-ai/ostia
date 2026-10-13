export type StorageKind = 'cookies' | 'local' | 'session'

export type CookieSameSite = 'unspecified' | 'no_restriction' | 'lax' | 'strict'

export interface StorageCookie {
  name: string
  value: string
  domain: string
  path: string
  hostOnly: boolean
  expires: number | null
  httpOnly: boolean
  secure: boolean
  sameSite: CookieSameSite
}

export interface StorageEntry {
  key: string
  value: string
}

export interface BrowserStorageSnapshot {
  origin: string
  cookies: StorageCookie[]
  local: StorageEntry[]
  session: StorageEntry[]
}

export type BrowserStorageRead =
  | { ok: true; snapshot: BrowserStorageSnapshot }
  | { ok: false; error: string }

export type StorageEdit =
  | { kind: 'cookies'; cookie: StorageCookie }
  | { kind: 'local' | 'session'; key: string; value: string }

export type StorageRemoval =
  | { kind: 'cookies'; cookie: Pick<StorageCookie, 'name' | 'domain' | 'path' | 'secure'> }
  | { kind: 'local' | 'session'; key: string }

export type StorageWriteResult = { ok: true } | { ok: false; error: string }

export const STORAGE_KEY_MAX = 4096
export const STORAGE_VALUE_MAX = 5 * 1024 * 1024

const SAME_SITE: CookieSameSite[] = ['unspecified', 'no_restriction', 'lax', 'strict']

export function isStorageKind(value: unknown): value is StorageKind {
  return value === 'cookies' || value === 'local' || value === 'session'
}

function isText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function normalizeCookie(raw: unknown): StorageCookie | null {
  const c = asRecord(raw)
  if (!c) return null
  if (!isText(c.name, STORAGE_KEY_MAX) || c.name === '') return null
  if (!isText(c.value, STORAGE_VALUE_MAX)) return null
  if (!isText(c.domain, 255) || c.domain.replace(/^\./, '') === '') return null
  if (!isText(c.path, STORAGE_KEY_MAX) || !c.path.startsWith('/')) return null
  const expires = c.expires === null ? null : Number(c.expires)
  if (expires !== null && !Number.isFinite(expires)) return null
  const sameSite = SAME_SITE.includes(c.sameSite as CookieSameSite)
    ? (c.sameSite as CookieSameSite)
    : 'unspecified'
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    hostOnly: c.hostOnly === true,
    expires,
    httpOnly: c.httpOnly === true,
    secure: c.secure === true,
    sameSite,
  }
}

export function normalizeStorageEdit(raw: unknown): StorageEdit | null {
  const edit = asRecord(raw)
  if (!edit) return null
  if (edit.kind === 'cookies') {
    const cookie = normalizeCookie(edit.cookie)
    return cookie ? { kind: 'cookies', cookie } : null
  }
  if (edit.kind !== 'local' && edit.kind !== 'session') return null
  if (!isText(edit.key, STORAGE_KEY_MAX) || edit.key === '') return null
  if (!isText(edit.value, STORAGE_VALUE_MAX)) return null
  return { kind: edit.kind, key: edit.key, value: edit.value }
}

export function normalizeStorageRemoval(raw: unknown): StorageRemoval | null {
  const removal = asRecord(raw)
  if (!removal) return null
  if (removal.kind === 'cookies') {
    const c = asRecord(removal.cookie)
    if (!c || !isText(c.name, STORAGE_KEY_MAX) || c.name === '') return null
    if (!isText(c.domain, 255) || c.domain.replace(/^\./, '') === '') return null
    if (!isText(c.path, STORAGE_KEY_MAX) || !c.path.startsWith('/')) return null
    return {
      kind: 'cookies',
      cookie: { name: c.name, domain: c.domain, path: c.path, secure: c.secure === true },
    }
  }
  if (removal.kind !== 'local' && removal.kind !== 'session') return null
  if (!isText(removal.key, STORAGE_KEY_MAX) || removal.key === '') return null
  return { kind: removal.kind, key: removal.key }
}

export function cookieUrl(cookie: Pick<StorageCookie, 'domain' | 'path' | 'secure'>): string {
  const host = cookie.domain.replace(/^\./, '')
  return `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path || '/'}`
}

export function entriesOf(record: Record<string, string>): StorageEntry[] {
  return Object.keys(record)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => ({ key, value: record[key] }))
}
