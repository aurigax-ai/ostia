import { VIEWER_SCHEME } from '@aurigax-ai/ostia-extension-sdk/contract/fileKinds'
import { lockDownSession } from '../../artifacts/previewAttach'
import type { PreviewSession } from '../../artifacts/previewHostTypes'

const VIEWER_PARTITION_PREFIX = 'ostia-viewer-'

function pageCsp(scriptSrc: string): string {
  return [
    "default-src 'none'",
    scriptSrc,
    "worker-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    "object-src 'none'",
  ].join('; ')
}

export const VIEWER_PAGE_CSP = pageCsp("script-src 'self'")

export const WASM_VIEWER_CSP = pageCsp("script-src 'self' 'wasm-unsafe-eval'")

const WASM_VIEWER_EXTENSIONS: ReadonlySet<string> = new Set(['pdf'])

export function viewerAllowsWasm(extId: string, builtin: boolean): boolean {
  return builtin && WASM_VIEWER_EXTENSIONS.has(extId)
}

export type ViewerSession = Pick<
  PreviewSession,
  | 'protocol'
  | 'webRequest'
  | 'setProxy'
  | 'setPermissionRequestHandler'
  | 'setPermissionCheckHandler'
  | 'on'
>

export function viewerPartition(extId: string): string {
  return `${VIEWER_PARTITION_PREFIX}${extId}`
}

export function extensionOfViewerPartition(partition: string | undefined): string | null {
  return partition?.startsWith(VIEWER_PARTITION_PREFIX)
    ? partition.slice(VIEWER_PARTITION_PREFIX.length)
    : null
}

function allowsViewerRequest(url: string): boolean {
  return url.startsWith(`${VIEWER_SCHEME}://`) || url.startsWith('data:') || url.startsWith('blob:')
}

export function hardenViewerSession(
  session: ViewerSession,
  serve: (request: Request) => Promise<Response>,
): void {
  session.protocol.handle(VIEWER_SCHEME, serve)
  session.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: !allowsViewerRequest(details.url) }),
  )
  lockDownSession(session, () => false)
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  woff2: 'font/woff2',
  wasm: 'application/wasm',
}

export function contentTypeOf(path: string): string {
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? ''
  return CONTENT_TYPES[extension] ?? 'application/octet-stream'
}

export function viewerHeaders(
  contentType: string,
  extra: Record<string, string> = {},
  wasm = false,
): Headers {
  return new Headers({
    'content-type': contentType,
    'content-security-policy': wasm ? WASM_VIEWER_CSP : VIEWER_PAGE_CSP,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-dns-prefetch-control': 'off',
    ...extra,
  })
}
