import { PREVIEW_SCHEME } from '../artifacts/htmlPreview'

export type LinkKind = 'browser' | 'external'

export interface ExternalLinkPolicy {
  apps: boolean
}

const BROWSER_SCHEMES = new Set(['http:', 'https:'])
const SYSTEM_SCHEMES = new Set(['mailto:'])
const APP_SCHEMES = new Set(['obsidian:', 'vscode:', 'vscode-insiders:'])
const BLOCKED_SCHEMES = new Set(
  [
    'javascript',
    'data',
    'vbscript',
    'blob',
    'about',
    'chrome-extension',
    'chrome-untrusted',
    'devtools',
    'view-source',
    'filesystem',
    'file',
    'ostia',
    PREVIEW_SCHEME,
    'remote',
    'untitled',
    'app',
    'smb',
    'cifs',
    'afp',
    'nfs',
    'ftp',
    'ftps',
    'dav',
    'davs',
    'webdav',
    'search',
    'search-ms',
  ].map((scheme) => `${scheme}:`),
)
const BROWSER_PAGE_SCHEMES = {
  'chrome:': 'chrome',
  'edge:': 'edge',
  'brave:': 'brave',
} as const
const SCHEME_FORMAT = /^[a-z][a-z0-9+.-]+:$/

function parse(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

function isAppLink(url: URL): boolean {
  const scheme = url.protocol
  if (BLOCKED_SCHEMES.has(scheme) || scheme.startsWith('ms-') || !SCHEME_FORMAT.test(scheme)) {
    return false
  }
  if (APP_SCHEMES.has(scheme)) return true
  return url.href.startsWith(`${scheme}//`) && !url.password
}

export function linkKind(url: string): LinkKind | null {
  const parsed = parse(url)
  if (!parsed) return null
  if (BROWSER_SCHEMES.has(parsed.protocol)) return 'browser'
  return SYSTEM_SCHEMES.has(parsed.protocol) || isAppLink(parsed) ? 'external' : null
}

export type BrowserPage = (typeof BROWSER_PAGE_SCHEMES)[keyof typeof BROWSER_PAGE_SCHEMES]

export function browserPageOf(url: string): BrowserPage | null {
  const parsed = parse(url)
  if (!parsed || !isAppLink(parsed)) return null
  return BROWSER_PAGE_SCHEMES[parsed.protocol as keyof typeof BROWSER_PAGE_SCHEMES] ?? null
}

export function appLinkScheme(url: string): string | null {
  const parsed = parse(url)
  if (!parsed || BROWSER_SCHEMES.has(parsed.protocol) || SYSTEM_SCHEMES.has(parsed.protocol)) {
    return null
  }
  if (!isAppLink(parsed)) return null
  return parsed.protocol.slice(0, -1)
}

export function externalHref(url: string, policy: ExternalLinkPolicy): string | null {
  const parsed = parse(url)
  if (!parsed) return null
  const scheme = parsed.protocol
  const allowed =
    BROWSER_SCHEMES.has(scheme) || SYSTEM_SCHEMES.has(scheme) || (policy.apps && isAppLink(parsed))
  return allowed ? parsed.href : null
}

export interface AppLinkMatch {
  start: number
  end: number
  url: string
}

const SCHEME = String.raw`[a-z][a-z0-9+.-]+:\/\/`
const BRACKETED = new RegExp(String.raw`<(${SCHEME}[^<>\r\n]+)>`, 'gi')
const PLAIN = new RegExp(String.raw`(?<![\w+.:/-])${SCHEME}[^\s<>"'\`　-〿＀-￯]+`, 'gi')
const TRAILING = new Set(['.', ',', ';', ':', '!', '?', "'", '"'])
const OPENER: Record<string, string> = { ')': '(', ']': '[' }

function balanced(url: string): string {
  const count: Record<string, number> = { '(': 0, ')': 0, '[': 0, ']': 0 }
  for (const ch of url) if (ch in count) count[ch]++
  let end = url.length
  while (end > 0) {
    const ch = url[end - 1]
    const opener = OPENER[ch]
    if (TRAILING.has(ch)) end--
    else if (opener && count[ch] > count[opener]) {
      count[ch]--
      end--
    } else break
  }
  return url.slice(0, end)
}

export function findSchemeLinks(text: string, accepts: (url: string) => boolean): AppLinkMatch[] {
  const out: AppLinkMatch[] = []
  for (const m of text.matchAll(BRACKETED)) {
    const start = (m.index ?? 0) + 1
    if (!accepts(m[1])) continue
    out.push({ start, end: start + m[1].length, url: m[1] })
  }
  const covered = (start: number, end: number): boolean =>
    out.some((link) => start < link.end + 1 && end > link.start - 1)
  for (const m of text.matchAll(PLAIN)) {
    const start = m.index ?? 0
    const url = balanced(m[0])
    if (!/:\/\/./.test(url) || !accepts(url) || covered(start, start + url.length)) continue
    out.push({ start, end: start + url.length, url })
  }
  return out.sort((a, b) => a.start - b.start)
}

export function findAppLinks(text: string): AppLinkMatch[] {
  return findSchemeLinks(text, (url) => linkKind(url) === 'external')
}
