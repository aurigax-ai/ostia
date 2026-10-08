import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const DOWNLOAD_MAX_REDIRECTS = 5

export type DownloadFailure = 'host-not-allowed' | 'redirect-refused' | 'http-error' | 'too-large'

export class DownloadError extends Error {
  constructor(
    readonly reason: DownloadFailure,
    readonly detail = '',
  ) {
    super(detail ? `${reason}: ${detail}` : reason)
  }
}

export type Fetch = typeof fetch

export function isAllowedHop(url: URL, hosts: readonly string[], testBase: string | null): boolean {
  if (testBase) return url.origin === new URL(testBase).origin
  return (
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    !url.port &&
    hosts.includes(url.hostname)
  )
}

export interface DownloadRequest {
  fetch: Fetch
  url: URL
  allowed: (url: URL) => boolean
  userAgent: string
  signal: AbortSignal
}

export async function followAllowed(request: DownloadRequest): Promise<Response> {
  let url = request.url
  if (!request.allowed(url)) throw new DownloadError('host-not-allowed', url.hostname)
  for (let hop = 0; ; hop++) {
    const response = await request.fetch(url, {
      headers: { 'User-Agent': request.userAgent },
      redirect: 'manual',
      signal: request.signal,
    })
    if (response.status < 300 || response.status > 399) {
      if (response.status === 200 && response.body) return response
      await response.body?.cancel()
      throw new DownloadError('http-error', String(response.status))
    }
    const location = response.headers.get('location')
    await response.body?.cancel()
    if (!location || hop >= DOWNLOAD_MAX_REDIRECTS) throw new DownloadError('redirect-refused')
    const next = new URL(location, url)
    if (!request.allowed(next)) throw new DownloadError('redirect-refused', next.hostname)
    url = next
  }
}

export function bodyOf(response: Response): Readable {
  return Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
}

export async function downloadChecked(
  request: DownloadRequest & {
    file: string
    exclusive: boolean
    maxBytes: number
    onProgress: (received: number, total: number) => void
  },
): Promise<string> {
  const response = await followAllowed(request)
  const total = Number(response.headers.get('content-length') ?? 0)
  if (total > request.maxBytes) {
    await response.body?.cancel()
    throw new DownloadError('too-large')
  }
  const hash = createHash('sha256')
  let received = 0
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      received += chunk.byteLength
      if (received > request.maxBytes) {
        done(new DownloadError('too-large'))
        return
      }
      hash.update(chunk)
      request.onProgress(received, total)
      done(null, chunk)
    },
  })
  await pipeline(
    bodyOf(response),
    meter,
    createWriteStream(request.file, { mode: 0o600, flags: request.exclusive ? 'wx' : 'w' }),
  )
  return hash.digest('hex')
}
