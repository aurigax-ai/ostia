import { type CardThread, loopbackHttpUrl, parseCardThread } from './trellis'

export interface DaemonApi {
  origin: string
  token: string
}

const TOKEN_HEADER = 'x-trellis-token'
const THREAD_MAX_BYTES = 4 * 1024 * 1024
const TIMEOUT_MS = 5000

export function daemonApi(url: string | null): DaemonApi | null {
  const parsed = loopbackHttpUrl(url)
  const token = parsed?.searchParams.get('token')
  return parsed && token ? { origin: parsed.origin, token } : null
}

export function threadUrl(api: DaemonApi, project: string, board: string, ref: string): string {
  const path = ['api', 'p', project, 'b', board, 'cards', ref].map(encodeURIComponent).join('/')
  return `${api.origin}/${path}`
}

export async function readThread(
  api: DaemonApi,
  project: string,
  board: string,
  ref: string,
): Promise<CardThread | null> {
  try {
    const res = await fetch(threadUrl(api, project, board, ref), {
      headers: { [TOKEN_HEADER]: api.token, accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return null
    const text = await res.text()
    if (text.length > THREAD_MAX_BYTES) return null
    return parseCardThread(text)
  } catch {
    return null
  }
}
