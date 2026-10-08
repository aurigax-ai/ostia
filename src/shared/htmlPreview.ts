export const PREVIEW_SCHEME = 'ostia-preview'
export const PREVIEW_PARTITION_PREFIX = 'ostia-preview-'

export const PREVIEW_LIMITS = {
  notRespondingMs: 5_000,
  stopUnresponsiveMs: 15_000,
  memoryBytes: 512 * 1024 * 1024,
  hiddenMs: 60_000,
  busyMs: 30_000,
  perWindow: 4,
  loadBytes: 16 * 1024 * 1024,
  errorBytes: 8 * 1024,
  reloadDebounceMs: 300,
} as const

export type PreviewLimits = { readonly [K in keyof typeof PREVIEW_LIMITS]: number }

export type PreviewStopReason = 'unresponsive' | 'memory' | 'hidden' | 'limit' | 'crashed' | 'human'

export interface PreviewOpened {
  id: string
  partition: string
  url: string
}

export interface PreviewError {
  kind: 'error' | 'blocked'
  message: string
  source?: string
  line?: number
}

export type PreviewEvent =
  | { id: string; type: 'loading' }
  | { id: string; type: 'error'; error: PreviewError }
  | { id: string; type: 'vitals'; responding: boolean; busy: boolean }
  | { id: string; type: 'link'; url: string }
  | { id: string; type: 'stopped'; reason: PreviewStopReason }

export interface PreviewApi {
  open: (paneId: string, path: string) => Promise<PreviewOpened | null>
  shown: (id: string, visible: boolean) => void
  stop: (id: string) => void
  close: (id: string) => void
  onEvent: (cb: (event: PreviewEvent) => void) => () => void
}

export function isPreviewPath(path: string | undefined): boolean {
  return path !== undefined && /\.html?$/i.test(path)
}

export function previewPartition(nonce: string): string {
  return `${PREVIEW_PARTITION_PREFIX}${nonce}`
}

export function isPreviewPartition(partition: string | undefined): boolean {
  return partition?.startsWith(PREVIEW_PARTITION_PREFIX) === true
}

export function allowsPreviewRequest(url: string): boolean {
  return url.startsWith(`${PREVIEW_SCHEME}:`)
}

export function blockedHost(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.host || parsed.protocol.replace(/:$/, '')
  } catch {
    return url.slice(0, 80)
  }
}

const POLICY_MESSAGE = /Content Security Policy/i
const REMOTE_URL = /'((?:https?|wss?|ftp):\/\/[^']+)'/i

export function blockedByPolicy(message: string): string | null {
  if (!POLICY_MESSAGE.test(message)) return null
  const url = REMOTE_URL.exec(message)?.[1]
  return url ? blockedHost(url) : null
}

export function isWebLink(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

export const PREVIEW_PAGE_CSP = [
  "default-src 'none'",
  `script-src ${PREVIEW_SCHEME}: 'unsafe-inline'`,
  `style-src ${PREVIEW_SCHEME}: 'unsafe-inline'`,
  `img-src ${PREVIEW_SCHEME}: data: blob:`,
  `font-src ${PREVIEW_SCHEME}: data:`,
  `media-src ${PREVIEW_SCHEME}: data: blob:`,
  `connect-src ${PREVIEW_SCHEME}:`,
  "worker-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  'sandbox allow-scripts',
].join('; ')

export function keepErrors(
  errors: readonly PreviewError[],
  next: PreviewError,
  maxBytes: number = PREVIEW_LIMITS.errorBytes,
): PreviewError[] {
  const kept = [...errors, next]
  let bytes = kept.reduce((sum, error) => sum + error.message.length, 0)
  while (kept.length > 1 && bytes > maxBytes) {
    bytes -= kept[0].message.length
    kept.shift()
  }
  if (kept[0].message.length > maxBytes) {
    kept[0] = { ...kept[0], message: kept[0].message.slice(0, maxBytes) }
  }
  return kept
}

export function previewErrorLine(error: PreviewError): string {
  if (error.line === undefined) return error.message
  const where = error.source ? `${error.source}:${error.line}` : `line ${error.line}`
  return `${error.message} (${where})`
}
