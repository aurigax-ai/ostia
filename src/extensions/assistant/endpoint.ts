import { Agent, fetch as undiciFetch } from 'undici'

export const UNIX_PREFIX = 'unix:'
const SOCKET_ORIGIN = 'http://localhost'
const ERROR_BODY_MAX = 200

export type FetchFn = typeof globalThis.fetch

export interface Endpoint {
  socketPath?: string
  origin: string
  basePath: string
}

export function parseEndpoint(raw: string): Endpoint | null {
  const value = raw.trim()
  if (value.startsWith(UNIX_PREFIX)) {
    const socketPath = value.slice(UNIX_PREFIX.length)
    return socketPath.startsWith('/') ? { socketPath, origin: SOCKET_ORIGIN, basePath: '' } : null
  }
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.username || url.password) return null
    return { origin: url.origin, basePath: url.pathname.replace(/\/+$/, '') }
  } catch {
    return null
  }
}

export function baseUrl(endpoint: Endpoint, extra = ''): string {
  return `${endpoint.origin}${endpoint.basePath}${extra}`
}

export function endpointFetch(endpoint: Endpoint): FetchFn {
  if (!endpoint.socketPath) return globalThis.fetch
  const dispatcher = new Agent({ connect: { socketPath: endpoint.socketPath } })
  return ((input: string | URL | Request, init?: RequestInit) =>
    undiciFetch(input as never, { ...(init as object), dispatcher } as never)) as unknown as FetchFn
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export function errorMessage(status: number, body: string): string {
  let detail = body.trim()
  try {
    const parsed = JSON.parse(detail) as { error?: unknown; message?: unknown }
    const error = parsed.error
    if (typeof error === 'string') detail = error
    else if (error && typeof error === 'object' && 'message' in error) {
      detail = String((error as { message: unknown }).message)
    } else if (typeof parsed.message === 'string') detail = parsed.message
  } catch {}
  detail = detail.replace(/\s+/g, ' ').slice(0, ERROR_BODY_MAX)
  return detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`
}

export interface JsonRequest {
  fetch: FetchFn
  url: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: unknown
  signal?: AbortSignal
  timeoutMs: number
}

export async function requestJson<T>(req: JsonRequest): Promise<T> {
  const timeout = AbortSignal.timeout(req.timeoutMs)
  const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout
  const res = await req.fetch(req.url, {
    method: req.method ?? 'GET',
    headers: {
      accept: 'application/json',
      ...(req.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...req.headers,
    },
    ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
    signal,
  })
  const body = await res.text()
  if (!res.ok) throw new HttpError(res.status, errorMessage(res.status, body))
  if (!body.trim()) return {} as T
  try {
    return JSON.parse(body) as T
  } catch {
    throw new Error('invalid JSON from provider')
  }
}
