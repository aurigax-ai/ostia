import { type IncomingMessage, type RequestOptions, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

export const UNIX_PREFIX = 'unix:'
const MAX_BODY_BYTES = 8 * 1024 * 1024
const ERROR_BODY_MAX = 200

export interface Endpoint {
  socketPath?: string
  origin?: string
  basePath: string
  secure: boolean
}

export function parseEndpoint(raw: string): Endpoint | null {
  const value = raw.trim()
  if (value.startsWith(UNIX_PREFIX)) {
    const socketPath = value.slice(UNIX_PREFIX.length)
    return socketPath.startsWith('/') ? { socketPath, basePath: '', secure: false } : null
  }
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.username || url.password) return null
    return {
      origin: url.origin,
      basePath: url.pathname.replace(/\/+$/, ''),
      secure: url.protocol === 'https:',
    }
  } catch {
    return null
  }
}

export function describeEndpoint(endpoint: Endpoint): string {
  return endpoint.socketPath
    ? `${UNIX_PREFIX}${endpoint.socketPath}`
    : `${endpoint.origin}${endpoint.basePath}`
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export class AbortedError extends Error {
  constructor() {
    super('aborted')
  }
}

export interface HttpOptions {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: unknown
  signal?: AbortSignal
  timeoutMs?: number
}

function requestOptions(endpoint: Endpoint, path: string, opts: HttpOptions): RequestOptions {
  const headers: Record<string, string> = { accept: '*/*', ...opts.headers }
  if (opts.body !== undefined) headers['content-type'] = 'application/json'
  const fullPath = `${endpoint.basePath}${path}`
  if (endpoint.socketPath) {
    return {
      socketPath: endpoint.socketPath,
      path: fullPath,
      method: opts.method ?? 'GET',
      headers: { host: 'localhost', ...headers },
    }
  }
  const url = new URL(fullPath, endpoint.origin)
  return {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port,
    path: `${url.pathname}${url.search}`,
    method: opts.method ?? 'GET',
    headers,
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

export function open(
  endpoint: Endpoint,
  path: string,
  opts: HttpOptions,
  onResponse: (res: IncomingMessage, fail: (err: Error) => void) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new AbortedError())
      return
    }
    let settled = false
    const settle = (err?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      if (err) {
        req.destroy()
        reject(err)
      } else resolve()
    }
    const send = endpoint.secure ? httpsRequest : httpRequest
    const req = send(requestOptions(endpoint, path, opts), (res) => {
      res.on('end', () => settle())
      res.on('close', () => settle(settled ? undefined : new Error('connection closed')))
      res.on('error', (err) => settle(err))
      onResponse(res, (err) => settle(err))
    })
    const onAbort = (): void => settle(new AbortedError())
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => settle(new Error('request timed out')), opts.timeoutMs ?? 30_000)
    req.on('error', (err) => settle(err))
    if (opts.body !== undefined) req.write(JSON.stringify(opts.body))
    req.end()
  })
}

export interface HttpResult {
  status: number
  body: string
}

export async function fetchText(
  endpoint: Endpoint,
  path: string,
  opts: HttpOptions = {},
): Promise<HttpResult> {
  let status = 0
  const chunks: Buffer[] = []
  let size = 0
  await open(endpoint, path, opts, (res, fail) => {
    status = res.statusCode ?? 0
    res.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) fail(new Error('response too large'))
      else chunks.push(chunk)
    })
  })
  return { status, body: Buffer.concat(chunks).toString('utf8') }
}

export async function fetchJson<T>(
  endpoint: Endpoint,
  path: string,
  opts: HttpOptions = {},
): Promise<T> {
  const res = await fetchText(endpoint, path, opts)
  if (res.status < 200 || res.status >= 300) {
    throw new HttpError(res.status, errorMessage(res.status, res.body))
  }
  if (!res.body.trim()) return {} as T
  try {
    return JSON.parse(res.body) as T
  } catch {
    throw new Error('invalid JSON from provider')
  }
}

export interface SseEvent {
  event?: string
  data: string
}

export function createSseParser(onEvent: (event: SseEvent) => void): (chunk: string) => void {
  let buffer = ''
  let event: string | undefined
  let data: string[] = []
  const dispatch = (): void => {
    if (data.length > 0)
      onEvent(event === undefined ? { data: data.join('\n') } : { event, data: data.join('\n') })
    event = undefined
    data = []
  }
  return (chunk) => {
    buffer += chunk
    let newline = buffer.search(/\r?\n/)
    while (newline !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(buffer[newline] === '\r' ? newline + 2 : newline + 1)
      if (line === '') dispatch()
      else if (!line.startsWith(':')) {
        const colon = line.indexOf(':')
        const field = colon === -1 ? line : line.slice(0, colon)
        const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')
        if (field === 'data') data.push(value)
        else if (field === 'event') event = value
      }
      newline = buffer.search(/\r?\n/)
    }
  }
}

export async function streamSse(
  endpoint: Endpoint,
  path: string,
  opts: HttpOptions,
  onEvent: (event: SseEvent) => void,
): Promise<void> {
  let failure: HttpError | null = null
  let errorBody = ''
  await open(endpoint, path, opts, (res, fail) => {
    const status = res.statusCode ?? 0
    res.setEncoding('utf8')
    if (status < 200 || status >= 300) {
      res.on('data', (chunk: string) => {
        if (errorBody.length < 4096) errorBody += chunk
      })
      res.on('end', () => {
        failure = new HttpError(status, errorMessage(status, errorBody))
      })
      return
    }
    const feed = createSseParser((event) => {
      try {
        onEvent(event)
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)))
      }
    })
    res.on('data', (chunk: string) => feed(chunk))
    res.on('end', () => feed('\n\n'))
  })
  if (failure) throw failure
}
