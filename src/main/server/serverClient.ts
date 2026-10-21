import { setTimeout as sleep } from 'node:timers/promises'
import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'

const REQUEST_TIMEOUT_MS = 15_000
const RETRY_AFTER_MAX_S = 5

export class ServerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfter: number | null = null,
    readonly serverTime: number | null = null,
  ) {
    super(`${status} ${code}`)
  }
}

interface RequestOptions {
  body?: unknown
  json?: string
  reportsTime?: true
  bytes?: Uint8Array<ArrayBuffer>
  token?: string
  headers?: Record<string, string>
  asBytes?: boolean
  retryRateLimited?: false
}

export interface ServerClient {
  origin: () => string
  request: <T>(method: string, path: string, options?: RequestOptions) => Promise<T>
}

export interface ServerClientDeps {
  baseUrl: () => string | null
  fetchFn?: typeof fetch
  timeoutMs?: number
  pause?: (ms: number) => Promise<void>
  onServerTime?: (ms: number) => void
}

function retryAfterOf(response: Response): number | null {
  const seconds = Number(response.headers.get('Retry-After'))
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null
}

function serverTimeOf(response: Response): number | null {
  const served = Date.parse(response.headers.get('Date') ?? '')
  return Number.isFinite(served) ? served : null
}

async function failureOf(response: Response): Promise<ServerError> {
  let code = 'failed'
  try {
    const body: unknown = await response.json()
    if (isRecord(body) && typeof body.error === 'string') code = body.error
  } catch {}
  return new ServerError(response.status, code, retryAfterOf(response), serverTimeOf(response))
}

export function createServerClient({
  baseUrl,
  fetchFn = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
  pause = (ms) => sleep(ms),
  onServerTime,
}: ServerClientDeps): ServerClient {
  const origin = (): string => {
    const url = baseUrl()
    if (!url) throw new ServerError(0, 'no-server')
    return url
  }

  const send = async (method: string, path: string, options: RequestOptions): Promise<Response> => {
    const headers: Record<string, string> = { Accept: 'application/json', ...options.headers }
    if (options.body !== undefined || options.json !== undefined) {
      headers['Content-Type'] = 'application/json'
    }
    if (options.bytes !== undefined) headers['Content-Type'] = 'application/octet-stream'
    if (options.token) headers.Authorization = `Bearer ${options.token}`
    const base = origin()
    let response: Response
    try {
      response = await fetchFn(`${base}${path}`, {
        method,
        headers,
        body:
          options.bytes ??
          options.json ??
          (options.body === undefined ? undefined : JSON.stringify(options.body)),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      throw new ServerError(0, 'unreachable')
    }
    return response
  }

  const request = async <T>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> => {
    let response = await send(method, path, options)
    if (response.status === 429 && options.retryRateLimited !== false) {
      const wait = retryAfterOf(response)
      if (wait !== null && wait <= RETRY_AFTER_MAX_S) {
        await pause(wait * 1000)
        response = await send(method, path, options)
      }
    }
    if (!response.ok) throw await failureOf(response)
    const served = serverTimeOf(response)
    if (options.reportsTime && served !== null) onServerTime?.(served)
    if (response.status === 204) return undefined as T
    if (options.asBytes) return Buffer.from(await response.arrayBuffer()) as T
    try {
      const text = await response.text()
      return (text === '' ? undefined : JSON.parse(text)) as T
    } catch {
      throw new ServerError(response.status, 'bad-response')
    }
  }

  return { origin, request }
}
