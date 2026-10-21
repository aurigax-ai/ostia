import { randomBytes } from 'node:crypto'
import { type Dirent, readdirSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join, relative } from 'node:path'
import type { Duplex } from 'node:stream'
import type { ExtensionResult } from '@aurigax-ai/ostia-extension-sdk'
import { WebSocketServer } from 'ws'

export interface PanelScope {
  workspaceId: string
  locale: string
  panel: string
}

type PanelOpen = Omit<PanelScope, 'panel'>

interface VendorFiles {
  dir: string
  prefix: string
}

type PanelHandle = (command: string, args: unknown, scope: PanelScope) => Promise<ExtensionResult>

export interface PanelServerOptions {
  dir: string
  files: string[]
  handle: PanelHandle
  vendor?: VendorFiles
  openStream?: (scope: PanelScope, rest: string) => Duplex | null
}

export interface ScreensPanelServer {
  port: number
  open: (scope: PanelOpen) => string
  forget: (workspaceId: string) => void
  changed: () => void
  close: () => Promise<void>
}

const PANELS_MAX = 64
const VENDOR_FOLDERS = ['core', 'vendor']
const MAX_BODY = 64 * 1024
const TOKEN_PATH = /^\/([0-9a-f]{48})(\/.*)$/
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}
const PAGE_CSP = "default-src 'self'; img-src 'self' data:; font-src 'self' data:"

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': PAGE_CSP,
  })
  res.end(body)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('body too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function scriptsUnder(root: string, dir: string): string[] {
  let entries: Dirent[] = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return scriptsUnder(root, path)
    return entry.isFile() && entry.name.endsWith('.js') ? [relative(root, path)] : []
  })
}

function vendorIndex(vendor: VendorFiles | undefined): Map<string, string> {
  const index = new Map<string, string>()
  if (!vendor) return index
  for (const folder of VENDOR_FOLDERS) {
    for (const file of scriptsUnder(vendor.dir, join(vendor.dir, folder))) {
      index.set(`${vendor.prefix}${file.split('\\').join('/')}`, join(vendor.dir, file))
    }
  }
  return index
}

function refuseUpgrade(socket: Duplex, status: string): void {
  socket.end(`HTTP/1.1 ${status}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`)
}

export async function startPanelServer(opts: PanelServerOptions): Promise<ScreensPanelServer> {
  const panels = new Map<string, PanelOpen>()
  const streams = new Set<ServerResponse>()
  const vendored = vendorIndex(opts.vendor)
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 })
  let port = 0

  const scopeOf = (pathname: string): { scope: PanelScope; rest: string } | null => {
    const match = TOKEN_PATH.exec(pathname)
    const open = match ? panels.get(match[1]) : undefined
    return match && open ? { scope: { ...open, panel: match[1] }, rest: match[2] } : null
  }

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.headers.host !== `127.0.0.1:${port}`) return send(res, 403, 'text/plain', 'host')
    const origin = req.headers.origin
    if (origin && origin !== `http://127.0.0.1:${port}`) {
      return send(res, 403, 'text/plain', 'origin')
    }
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    const found = scopeOf(url.pathname)
    if (!found) return send(res, 404, 'text/plain', 'not found')
    const { scope, rest } = found
    if (req.method === 'GET' && rest === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      res.write(': ok\n\n')
      streams.add(res)
      req.on('close', () => streams.delete(res))
      return
    }
    if (req.method === 'POST' && rest === '/api') {
      if (req.headers['content-type'] !== 'application/json') {
        return send(res, 415, 'text/plain', 'json only')
      }
      try {
        const body = JSON.parse(await readBody(req)) as { command?: unknown; args?: unknown }
        if (typeof body.command !== 'string') throw new Error('missing command')
        const result = await opts.handle(body.command, body.args, scope)
        return send(res, 200, 'application/json', JSON.stringify(result))
      } catch (err) {
        const message = err instanceof Error ? err.message : 'bad request'
        return send(res, 400, 'application/json', JSON.stringify({ ok: false, error: message }))
      }
    }
    if (req.method !== 'GET') return send(res, 405, 'text/plain', 'method not allowed')
    const name = rest === '/' ? 'panel.html' : rest.slice(1)
    const file = opts.files.includes(name) ? join(opts.dir, name) : vendored.get(name)
    if (!file) return send(res, 404, 'text/plain', 'not found')
    try {
      const type = CONTENT_TYPES[name.slice(name.lastIndexOf('.'))] ?? 'application/octet-stream'
      return send(res, 200, type, readFileSync(file))
    } catch {
      return send(res, 404, 'text/plain', 'not found')
    }
  }

  const server: Server = createServer((req, res) => {
    route(req, res).catch(() => send(res, 500, 'text/plain', 'failed'))
  })
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy())
    if (req.headers.host !== `127.0.0.1:${port}`) return refuseUpgrade(socket, '403 Forbidden')
    if (req.headers.origin !== `http://127.0.0.1:${port}`) {
      return refuseUpgrade(socket, '403 Forbidden')
    }
    const found = scopeOf(new URL(req.url ?? '/', `http://127.0.0.1:${port}`).pathname)
    const stream = found && opts.openStream ? opts.openStream(found.scope, found.rest) : null
    if (!stream) return refuseUpgrade(socket, '404 Not Found')
    sockets.handleUpgrade(req, socket, head, (ws) => {
      ws.binaryType = 'nodebuffer'
      ws.on('message', (data: Buffer) => stream.write(data))
      stream.on('data', (chunk: Buffer) => ws.send(chunk))
      stream.on('close', () => ws.close())
      stream.on('error', () => ws.terminate())
      ws.on('close', () => stream.destroy())
      ws.on('error', () => stream.destroy())
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  port = typeof address === 'object' && address ? address.port : 0

  return {
    port,
    open: (scope) => {
      const token = randomBytes(24).toString('hex')
      panels.set(token, { ...scope })
      while (panels.size > PANELS_MAX) {
        const oldest = panels.keys().next().value
        if (oldest === undefined) break
        panels.delete(oldest)
      }
      return `http://127.0.0.1:${port}/${token}/?${new URLSearchParams({ locale: scope.locale })}`
    },
    forget: (workspaceId) => {
      for (const [token, scope] of panels)
        if (scope.workspaceId === workspaceId) panels.delete(token)
    },
    changed: () => {
      for (const res of streams) res.write('data: changed\n\n')
    },
    close: () =>
      new Promise((resolve) => {
        for (const res of streams) res.end()
        for (const ws of sockets.clients) ws.terminate()
        sockets.close()
        server.close(() => resolve())
      }),
  }
}
