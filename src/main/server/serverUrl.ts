const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]'])
const EXPLICIT_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i

export function parseServerUrl(text: string, allowInsecure: boolean): string | null {
  const trimmed = text.trim()
  if (trimmed === '') return null
  let url: URL
  try {
    url = new URL(EXPLICIT_SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`)
  } catch {
    return null
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return null
  if (url.protocol === 'https:') return url.origin
  if (url.protocol === 'http:' && (allowInsecure || LOOPBACK_HOSTS.has(url.hostname))) {
    return url.origin
  }
  return null
}

export function socketOrigin(origin: string): string {
  return origin.replace(/^http/, 'ws')
}

export function hostOf(origin: string): string {
  return new URL(origin).host
}
