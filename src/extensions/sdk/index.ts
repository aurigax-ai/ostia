import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
} from 'vscode-jsonrpc/node'
import { ALL_CAPABILITIES } from '../../shared/capabilities'
import type {
  DiffContent,
  ExtensionCaller,
  ExtensionEventPayloads,
  ExtensionEventType,
  ExtensionIcon,
  ExtensionResult,
  SidebarTone,
} from '../../shared/extensions'
import { PRODUCT_NAME } from '../../shared/product'

export type { DiffContent, ExtensionCaller, ExtensionResult } from '../../shared/extensions'

export interface SessionInfo {
  sessionId: string
  name: string
  kind: string
  workDir: string
  state: string
  activePaneId?: string
}

export interface PaneInfo {
  paneId: string
  sessionId: string
  kind: string
  title: string
  cwd?: string
  running: boolean
  blockCount: number
  lastExitCode?: number
}

export type CommandHandler = (
  args: unknown,
  caller: ExtensionCaller,
) => ExtensionResult | Promise<ExtensionResult>

export type PanelHandler = (caller: ExtensionCaller) => { url: string } | Promise<{ url: string }>

export type EventHandler = <T extends ExtensionEventType>(
  type: T,
  payload: ExtensionEventPayloads[T],
) => void

export interface PineExtension {
  registerCommands: (handlers: Record<string, CommandHandler>) => Promise<void>
  onPanel: (handler: PanelHandler) => void
  subscribe: (events: ExtensionEventType[], handler: EventHandler) => Promise<unknown>
  setSidebarItem: (item: {
    key?: string
    sessionId?: string
    text: string
    icon?: ExtensionIcon
    tone?: SidebarTone
  }) => Promise<unknown>
  notify: (title: string, body?: string) => Promise<unknown>
  openPanel: (sessionId?: string) => Promise<unknown>
  openDiff: (diff: DiffContent & { sessionId?: string }) => Promise<ExtensionResult>
  listSessions: () => Promise<SessionInfo[]>
  listPanes: () => Promise<PaneInfo[]>
}

export function ok(text?: string, data?: unknown): ExtensionResult {
  const result: ExtensionResult = { ok: true }
  if (text !== undefined) result.text = text
  if (data !== undefined) result.data = data
  return result
}

export function failure(error: string, message?: string): ExtensionResult {
  return message ? { ok: false, error, message } : { ok: false, error }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export async function connect(): Promise<PineExtension> {
  const socketPath = process.env.PINE_SOCKET
  const token = process.env.PINE_TOKEN
  if (!socketPath || !token) throw new Error('PINE_SOCKET / PINE_TOKEN missing')
  const socket = createConnection(socketPath)
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  const conn: MessageConnection = createMessageConnection(
    new StreamMessageReader(socket),
    new StreamMessageWriter(socket),
  )
  const handlers = new Map<string, CommandHandler>()
  let panelHandler: PanelHandler | null = null
  let eventHandler: EventHandler | null = null

  conn.onRequest(
    'ext.command',
    async (params: { command: string; args: unknown; caller: ExtensionCaller }) => {
      const handler = handlers.get(params.command)
      if (!handler) return failure('unknown-command', params.command)
      try {
        return await handler(params.args, params.caller)
      } catch (err) {
        return failure('command-failed', errorMessage(err))
      }
    },
  )
  conn.onRequest('ext.panel', async (params: { caller: ExtensionCaller }) => {
    if (!panelHandler) throw new Error('no panel handler')
    return panelHandler(params.caller)
  })
  conn.onNotification('ext.event', (params: { type: ExtensionEventType; payload: never }) => {
    eventHandler?.(params.type, params.payload)
  })
  conn.onClose(() => process.exit(0))
  socket.on('close', () => process.exit(0))
  conn.listen()
  await conn.sendRequest('hello', { token })

  return {
    registerCommands: async (map) => {
      for (const [id, handler] of Object.entries(map)) handlers.set(id, handler)
      await conn.sendRequest('ext.registerCommands', { commands: Object.keys(map) })
    },
    onPanel: (handler) => {
      panelHandler = handler
    },
    subscribe: (events, handler) => {
      eventHandler = handler
      return conn.sendRequest('ext.subscribe', { events })
    },
    setSidebarItem: (item) => conn.sendRequest('ext.setSidebarItem', item),
    notify: (title, body) => conn.sendRequest('ext.notify', { title, body }),
    openPanel: (sessionId) => conn.sendRequest('ext.openPanel', { sessionId }),
    openDiff: (diff) => conn.sendRequest('ext.openDiff', diff),
    listSessions: () => conn.sendRequest('session.list'),
    listPanes: () => conn.sendRequest('pane.list'),
  }
}

export interface CliArgs {
  argv: string[]
  stdin?: string
}

export function cliArgs(args: unknown): CliArgs | null {
  if (typeof args !== 'object' || args === null) return null
  const argv = (args as { argv?: unknown }).argv
  if (!Array.isArray(argv) || !argv.every((a) => typeof a === 'string')) return null
  const stdin = (args as { stdin?: unknown }).stdin
  return typeof stdin === 'string' ? { argv, stdin } : { argv }
}

export function namedArgs(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {}
}

export function parseFlags(
  argv: string[],
  valueFlags: string[],
  boolFlags: string[] = [],
): { flags: Record<string, string>; bools: Set<string>; rest: string[] } {
  const flags: Record<string, string> = {}
  const bools = new Set<string>()
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const name = arg.startsWith('--') ? arg.slice(2) : ''
    if (valueFlags.includes(name) && i + 1 < argv.length) {
      flags[name] = argv[++i]
    } else if (boolFlags.includes(name)) {
      bools.add(name)
    } else {
      rest.push(arg)
    }
  }
  return { flags, bools, rest }
}

export function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

export function projectStorePath(name: string, workDir: string): string {
  return join(expandHome(workDir), '.pine', `${name}.json`)
}

export function globalStorePath(name: string): string {
  const base = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  return join(base, PRODUCT_NAME, `${name}.json`)
}

export function loadJson<T>(path: string, fallback: T): T {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : fallback
  } catch {
    return fallback
  }
}

export function saveJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  renameSync(tmp, path)
  try {
    chmodSync(path, 0o600)
  } catch {}
}

export function panelCaller(context: Record<string, unknown>): ExtensionCaller {
  const caller: ExtensionCaller = { kind: 'user', capabilities: [...ALL_CAPABILITIES] }
  if (typeof context.workDir === 'string' && context.workDir) caller.workDir = context.workDir
  if (typeof context.sessionId === 'string' && context.sessionId) {
    caller.sessionId = context.sessionId
  }
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
    'content-security-policy': "default-src 'self'; img-src 'self' data:",
  })
  res.end(body)
}

export async function startPanelServer(opts: {
  dir: string
  files: string[]
  handle: (command: string, args: unknown, caller: ExtensionCaller) => Promise<ExtensionResult>
}): Promise<PanelServer> {
  const secret = randomBytes(24).toString('hex')
  const streams = new Set<ServerResponse>()
  let port = 0

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.headers.host !== `127.0.0.1:${port}`) return send(res, 421, 'text/plain', 'bad host')
    const origin = req.headers.origin
    if (origin && origin !== `http://127.0.0.1:${port}`)
      return send(res, 403, 'text/plain', 'origin')
    const authed = req.headers['x-pine-panel'] === secret || url.searchParams.get('t') === secret

    if (req.method === 'GET' && url.pathname === '/events') {
      if (!authed) return send(res, 403, 'text/plain', 'forbidden')
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      res.write(': ok\n\n')
      streams.add(res)
      req.on('close', () => streams.delete(res))
      return
    }
    if (req.method === 'POST' && url.pathname === '/api') {
      if (req.headers['x-pine-panel'] !== secret) return send(res, 403, 'text/plain', 'forbidden')
      try {
        const body = JSON.parse(await readBody(req)) as {
          command?: unknown
          args?: unknown
          context?: Record<string, unknown>
        }
        if (typeof body.command !== 'string') throw new Error('missing command')
        const result = await opts.handle(body.command, body.args, panelCaller(body.context ?? {}))
        return send(res, 200, 'application/json', JSON.stringify(result))
      } catch (err) {
        return send(
          res,
          400,
          'application/json',
          JSON.stringify(failure('bad-request', errorMessage(err))),
        )
      }
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
