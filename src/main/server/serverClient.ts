import { setTimeout as sleep } from 'node:timers/promises'
import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'

const REQUEST_TIMEOUT_MS = 15_000
const RETRY_AFTER_MAX_S = 5

export class ServerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfter: number | null = null,
  ) {
    super(`${status} ${code}`)
  }
}

interface RequestOptions {
  body?: unknown
  token?: string
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
}

function retryAfterOf(response: Response): number | null {
  const seconds = Number(response.headers.get('Retry-After'))
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null
}

async function failureOf(response: Response): Promise<ServerError> {
  let code = 'failed'
  try {
    const body: unknown = await response.json()
    if (isRecord(body) && typeof body.error === 'string') code = body.error
  } catch {}
  return new ServerError(response.status, code, retryAfterOf(response))
}

export function createServerClient({
  baseUrl,
  fetchFn = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
  pause = (ms) => sleep(ms),
}: ServerClientDeps): ServerClient {
  const origin = (): string => {
    const url = baseUrl()
    if (!url) throw new ServerError(0, 'no-server')
    return url
  }

  const send = async (method: string, path: string, options: RequestOptions): Promise<Response> => {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (options.body !== undefined) headers['Content-Type'] = 'application/json'
    if (options.token) headers.Authorization = `Bearer ${options.token}`
    const base = origin()
    try {
      return await fetchFn(`${base}${path}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      throw new ServerError(0, 'unreachable')
    }
  }

  const request = async <T>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> => {
    let response = await send(method, path, options)
    if (response.status === 429) {
      const wait = retryAfterOf(response)
      if (wait !== null && wait <= RETRY_AFTER_MAX_S) {
        await pause(wait * 1000)
        response = await send(method, path, options)
      }
    }
    if (!response.ok) throw await failureOf(response)
    if (response.status === 204) return undefined as T
    try {
      return (await response.json()) as T
    } catch {
      throw new ServerError(response.status, 'bad-response')
    }
  }

  return { origin, request }
}
