import { randomBytes, timingSafeEqual } from 'node:crypto'
import {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer,
  request,
} from 'node:http'

export interface ProxyUpstream {
  origin: string
  headers: Record<string, string>
}

export interface AuthProxy {
  entryUrl: (path: string) => string
  close: () => Promise<void>
  port: number
}

export interface AuthProxyOptions {
  upstream: () => ProxyUpstream | null
  isAllowedEntry: (path: string) => boolean
}

const COOKIE = 'pine_proxy'
const HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
])

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return v.join('=')
  }
  return null
}

function plain(res: ServerResponse, status: number, body: string): undefined {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

function forwardHeaders(
  headers: IncomingHttpHeaders,
  upstream: ProxyUpstream,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || HOP_HEADERS.has(k) || k === 'cookie' || k === 'referer') continue
    out[k] = v
  }
  const up = new URL(upstream.origin)
  out.host = up.host
  if (headers.origin) out.origin = up.origin
  for (const [k, v] of Object.entries(upstream.headers)) out[k.toLowerCase()] = v
  return out
}

export async function startAuthProxy(opts: AuthProxyOptions): Promise<AuthProxy> {
  const secret = randomBytes(24).toString('hex')
  let port = 0

  const handle = (req: IncomingMessage, res: ServerResponse): undefined => {
    if (req.headers.host !== `127.0.0.1:${port}`) return plain(res, 421, 'bad host')
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)

    if (url.pathname === '/__pine/enter') {
      const t = url.searchParams.get('t') ?? ''
      if (!sameSecret(t, secret)) return plain(res, 403, 'forbidden')
      const to = url.searchParams.get('to') ?? '/'
      res.writeHead(303, {
        'set-cookie': `${COOKIE}=${secret}; Path=/; HttpOnly; SameSite=Strict`,
        location: opts.isAllowedEntry(to) ? to : '/',
        'cache-control': 'no-store',
      })
      res.end()
      return
    }

    const cookie = cookieValue(req.headers.cookie, COOKIE)
    if (!cookie || !sameSecret(cookie, secret)) return plain(res, 403, 'forbidden')
    const upstream = opts.upstream()
    if (!upstream) return plain(res, 503, 'upstream unavailable')
    const target = new URL(upstream.origin)
    const proxied = request(
      {
        hostname: target.hostname,
        port: target.port,
        method: req.method,
        path: req.url,
        headers: forwardHeaders(req.headers, upstream),
      },
      (up) => {
        const headers: Record<string, string | string[]> = {}
        for (const [k, v] of Object.entries(up.headers)) {
          if (v !== undefined && !HOP_HEADERS.has(k) && k !== 'set-cookie') headers[k] = v
        }
        res.writeHead(up.statusCode ?? 502, headers)
        up.pipe(res)
      },
    )
    proxied.on('error', () => {
      if (!res.headersSent) plain(res, 502, 'upstream unavailable')
      else res.destroy()
    })
    req.on('aborted', () => proxied.destroy())
    res.on('close', () => proxied.destroy())
    req.pipe(proxied)
  }

  const server: Server = createServer(handle)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  port = typeof address === 'object' && address ? address.port : 0

  return {
    port,
    entryUrl: (path) =>
      `http://127.0.0.1:${port}/__pine/enter?${new URLSearchParams({ t: secret, to: path })}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}
