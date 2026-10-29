import { mkdirSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import {
  createMessageConnection,
  ErrorCodes,
  type MessageConnection,
  ResponseError,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node'
import type { JobRecord, Jobs } from './jobs'
import { busMethods } from './nodeBus'

type Handler = (params: unknown) => unknown

export interface ControlDeps {
  socket: string
  version: string
  jobs: Jobs
  admin: Record<string, Handler>
}

const PANE_METHODS = ['pane.reportTurn', 'pane.reportWork', 'pane.setResume']

function paneHandlers(jobs: Jobs, pane: JobRecord): Record<string, Handler> {
  const noted: Record<string, Handler> = Object.fromEntries(
    PANE_METHODS.map((method) => [method, () => ({ ok: true })]),
  )
  return {
    ...busMethods(jobs, pane),
    ...noted,
    'pane.setAttention': (params) => {
      const { state } = (params ?? {}) as { state?: string }
      jobs.setState(pane.pane, state === 'working' || state === 'waiting' ? state : 'idle')
      return { ok: true }
    },
    'claudeAccount.start': () => ({ dir: '', memoryHome: '' }),
  }
}

function serveConnection(socket: Socket, deps: ControlDeps): void {
  const conn: MessageConnection = createMessageConnection(
    new StreamMessageReader(socket),
    new StreamMessageWriter(socket),
  )
  let pane: JobRecord | undefined
  let handlers: Record<string, Handler> = {}
  const register = (method: string, handler: Handler): void => {
    conn.onRequest(method, (params: unknown) => handler(params))
  }
  conn.onRequest('hello', (params: { token?: string } | undefined) => {
    const found = typeof params?.token === 'string' ? deps.jobs.byToken(params.token) : undefined
    if (!found) throw new ResponseError(ErrorCodes.InvalidRequest, 'bad-token')
    pane = found
    handlers = paneHandlers(deps.jobs, found)
    for (const [method, handler] of Object.entries(handlers)) register(method, handler)
    return { version: deps.version }
  })
  for (const [method, handler] of Object.entries(deps.admin)) {
    conn.onRequest(method, (params: unknown) => {
      if (pane) throw new ResponseError(ErrorCodes.InvalidRequest, 'not-allowed')
      return handler(params)
    })
  }
  socket.on('error', () => {})
  socket.on('close', () => conn.dispose())
  conn.listen()
}

export function listenControl(deps: ControlDeps): Promise<Server> {
  mkdirSync(dirname(deps.socket), { recursive: true, mode: 0o700 })
  rmSync(deps.socket, { force: true })
  const server = createServer((socket) => serveConnection(socket, deps))
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ path: deps.socket }, () => {
      server.off('error', reject)
      resolve(server)
    })
  })
}
