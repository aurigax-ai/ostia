import { type IncomingHttpHeaders, type Server, createServer, request } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type AuthProxy, startAuthProxy } from './proxy'
import { isAppPath } from './trellis'

interface Reply {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

function get(url: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, (res) => {
      let body = ''
      res.on('data', (c) => {
        body += c
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('trellis auth proxy', () => {
  let upstream: Server
  let seen: IncomingHttpHeaders[]
  let proxy: AuthProxy
  let upstreamOrigin: string

  beforeEach(async () => {
    seen = []
    upstream = createServer((req, res) => {
      seen.push(req.headers)
      res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': 'trellis_workspace=x' })
      res.end(`upstream ${req.url}`)
    })
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
    const addr = upstream.address()
    upstreamOrigin = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
    proxy = await startAuthProxy({
      upstream: () => ({ origin: upstreamOrigin, headers: { 'x-trellis-token': 'TESTTOKEN' } }),
      isAllowedEntry: isAppPath,
    })
  })

  afterEach(async () => {
    await proxy.close()
    await new Promise<void>((r) => upstream.close(() => r()))
  })

  const cookieFrom = async (path: string): Promise<{ cookie: string; location: string }> => {
    const res = await get(proxy.entryUrl(path))
    const setCookie = res.headers['set-cookie']?.[0] ?? ''
    return { cookie: setCookie.split(';')[0], location: String(res.headers.location) }
  }

  it('refuses requests without the entry cookie', async () => {
    const res = await get(`http://127.0.0.1:${proxy.port}/api/projects`)
    expect(res.status).toBe(403)
    expect(seen).toEqual([])
  })

  it('refuses an entry link with the wrong secret', async () => {
    const res = await get(`http://127.0.0.1:${proxy.port}/__pine/enter?t=nope&to=/`)
    expect(res.status).toBe(403)
  })

  it('refuses a foreign Host header', async () => {
    const res = await get(`http://127.0.0.1:${proxy.port}/`, { host: `evil.test:${proxy.port}` })
    expect(res.status).toBe(421)
  })

  it('lands on the project page and sets an HttpOnly same-site cookie', async () => {
    const res = await get(proxy.entryUrl('/p/SHOP'))
    expect(res.status).toBe(303)
    expect(res.headers.location).toBe('/p/SHOP')
    expect(res.headers['set-cookie']?.[0]).toMatch(/HttpOnly; SameSite=Strict/)
  })

  it('sends a disallowed entry path to the root instead', async () => {
    expect((await cookieFrom('//evil.example/')).location).toBe('/')
  })

  it('forwards with the trellis token, upstream Host and no browser cookies', async () => {
    const { cookie } = await cookieFrom('/')
    const res = await get(`http://127.0.0.1:${proxy.port}/api/projects`, {
      cookie,
      origin: `http://127.0.0.1:${proxy.port}`,
    })
    expect(res.status).toBe(200)
    expect(res.body).toBe('upstream /api/projects')
    expect(res.headers['set-cookie']).toBeUndefined()
    const headers = seen[0]
    expect(headers['x-trellis-token']).toBe('TESTTOKEN')
    expect(headers.host).toBe(new URL(upstreamOrigin).host)
    expect(headers.origin).toBe(upstreamOrigin)
    expect(headers.cookie).toBeUndefined()
  })
})
