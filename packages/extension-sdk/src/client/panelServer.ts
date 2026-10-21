import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { readEnv } from '../contract/appEnv'
import { ALL_CAPABILITIES } from '../contract/capabilities'
import type { ExtensionCaller, ExtensionResult, PanelToolbarState } from '../contract/extensions'
import { PANEL_TOOLBAR_PATH } from '../contract/extensionsBridge'
import { PANEL_SIZES_FILE, PanelSizeStore } from './panelSizes'
import { failure } from './results'
import { PANEL_SIZES_PATH } from './split'

function panelCaller(context: Record<string, unknown>): ExtensionCaller {
  const caller: ExtensionCaller = { kind: 'user', capabilities: [...ALL_CAPABILITIES] }
  if (typeof context.workDir === 'string' && context.workDir) caller.workDir = context.workDir
  if (typeof context.workspaceId === 'string' && context.workspaceId) {
    caller.workspaceId = context.workspaceId
  }
  if (typeof context.locale === 'string' && context.locale) caller.locale = context.locale
  return caller
}

export interface PanelServer {
  url: (query: Record<string, string>) => string
  changed: () => void
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

const MAX_BODY = 1024 * 1024

function responseMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'bad request'
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

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; img-src 'self' data:; font-src 'self' data:",
  })
  res.end(body)
}

async function jsonReply(res: ServerResponse, work: () => Promise<unknown>): Promise<void> {
  try {
    send(res, 200, 'application/json', JSON.stringify(await work()))
  } catch (err) {
    send(res, 400, 'application/json', JSON.stringify(failure('bad-request', responseMessage(err))))
  }
}

export async function startPanelServer(opts: {
  dir: string
  files: string[]
  handle: (command: string, args: unknown, caller: ExtensionCaller) => Promise<ExtensionResult>
  toolbar?: (state: PanelToolbarState & { workspaceId: string }) => Promise<ExtensionResult>
}): Promise<PanelServer> {
  const secret = randomBytes(24).toString('hex')
  const dataDir = readEnv('EXTENSION_DATA')
  const sizes = new PanelSizeStore(dataDir ? join(dataDir, PANEL_SIZES_FILE) : null)
  const streams = new Set<ServerResponse>()
  let port = 0

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.headers.host !== `127.0.0.1:${port}`) return send(res, 421, 'text/plain', 'bad host')
    const origin = req.headers.origin
    if (origin && origin !== `http://127.0.0.1:${port}`)
      return send(res, 403, 'text/plain', 'origin')
    const authed = req.headers['x-ostia-panel'] === secret || url.searchParams.get('t') === secret

    if (req.method === 'GET' && url.pathname === '/events') {
      if (!authed) return send(res, 403, 'text/plain', 'forbidden')
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      res.write(': ok\n\n')
      streams.add(res)
      req.on('close', () => streams.delete(res))
      return
    }
    if (url.pathname === PANEL_SIZES_PATH) {
      if (req.headers['x-ostia-panel'] !== secret) return send(res, 403, 'text/plain', 'forbidden')
      if (req.method === 'GET')
        return send(res, 200, 'application/json', JSON.stringify(sizes.all()))
      if (req.method !== 'POST') return send(res, 405, 'text/plain', 'method not allowed')
      return jsonReply(res, async () => {
        const body = JSON.parse(await readBody(req)) as { key?: unknown; fraction?: unknown }
        if (!sizes.set(body.key, body.fraction ?? null)) throw new Error('key, fraction')
        return sizes.all()
      })
    }
    if (req.method === 'POST' && url.pathname === PANEL_TOOLBAR_PATH) {
      if (req.headers['x-ostia-panel'] !== secret) return send(res, 403, 'text/plain', 'forbidden')
      return jsonReply(res, async () => {
        const body = JSON.parse(await readBody(req)) as PanelToolbarState & { workspaceId: string }
        return opts.toolbar ? opts.toolbar(body) : failure('not-contributed', 'no toolbar handler')
      })
    }
    if (req.method === 'POST' && url.pathname === '/api') {
      if (req.headers['x-ostia-panel'] !== secret) return send(res, 403, 'text/plain', 'forbidden')
      return jsonReply(res, async () => {
        const body = JSON.parse(await readBody(req)) as {
          command?: unknown
          args?: unknown
          context?: Record<string, unknown>
        }
        if (typeof body.command !== 'string') throw new Error('missing command')
        return opts.handle(body.command, body.args, panelCaller(body.context ?? {}))
      })
    }
    if (req.method === 'GET') {
      const name = url.pathname === '/' ? 'panel.html' : url.pathname.slice(1)
      if (!opts.files.includes(name)) return send(res, 404, 'text/plain', 'not found')
      const ext = name.slice(name.lastIndexOf('.'))
      try {
        return send(
          res,
          200,
          CONTENT_TYPES[ext] ?? 'application/octet-stream',
          readFileSync(join(opts.dir, name)),
        )
      } catch {
        return send(res, 404, 'text/plain', 'not found')
      }
    }
    send(res, 405, 'text/plain', 'method not allowed')
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  port = typeof address === 'object' && address ? address.port : 0

  return {
    url: (query) => {
      const params = new URLSearchParams({ ...query, t: secret })
      return `http://127.0.0.1:${port}/?${params.toString()}`
    },
    changed: () => {
      for (const res of streams) res.write('data: changed\n\n')
    },
  }
}
