import type { StorageCookie, StorageEntry } from '@shared/browser/browserStorage'

function matchesQuery(query: string, ...fields: string[]): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return fields.some((field) => field.toLowerCase().includes(q))
}

export function filterCookies(cookies: StorageCookie[], query: string): StorageCookie[] {
  return cookies.filter((c) => matchesQuery(query, c.name, c.value, c.domain, c.path))
}

export function filterEntries(entries: StorageEntry[], query: string): StorageEntry[] {
  return entries.filter((e) => matchesQuery(query, e.key, e.value))
}

export function cookieRowKey(cookie: Pick<StorageCookie, 'name' | 'domain' | 'path'>): string {
  return `${cookie.domain}\u0000${cookie.path}\u0000${cookie.name}`
}

export function formatExpiry(expires: number | null, sessionLabel: string): string {
  if (expires === null) return sessionLabel
  return new Date(expires * 1000).toLocaleString()
}
