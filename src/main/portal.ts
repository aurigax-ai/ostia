import { chmodSync, rmSync } from 'node:fs'
import { type Server, type Socket, createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ErrorCodes,
  ResponseError,
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
} from 'vscode-jsonrpc/node'
import { PRODUCT_NAME } from '../shared/product'
import { ManagerError, type ManagerService, parseOpenRequest } from './manager'
import type { CallerVerdict } from './portalCaller'

export function portalSocketPath(packaged: boolean): string {
  const override = process.env.PINE_PORTAL_SOCKET
  if (override) return override
  const name = packaged ? PRODUCT_NAME : `${PRODUCT_NAME}-dev`
  return join(process.env.XDG_RUNTIME_DIR || tmpdir(), `${name}-portal.sock`)
}

export function portalSupported(platform: NodeJS.Platform): boolean {
  return platform === 'linux'
}

export interface MirrorHandle {
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  detach: () => void
}

export interface MirrorSink {
  data: (data: string) => void
  exit: (code: number) => void
}

export interface PortalDeps {
  judge: (socket: Socket) => Promise<CallerVerdict>
  manager: ManagerService
  attachMirror: (paneId: string, sink: MirrorSink) => MirrorHandle | null
}

export interface PortalOpenResult {
  paneId: string
  agent: string
  created: boolean
}

const MAX_INPUT_CHUNK = 64 * 1024

function refuse(message: string): ResponseError<void> {
  return new ResponseError(ErrorCodes.InvalidRequest, message)
}

function verdictError(verdict: CallerVerdict): ResponseError<void> | null {
  if (verdict === 'inside') {
    return refuse('inside-pine: the manager can only be opened from a terminal outside Pine')
  }
  if (verdict === 'unknown') {
    return refuse('unknown-caller: Pine could not check where this request came from')
  }
  return null
}

function isLiveSocket(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createConnection(path)
    probe.once('connect', () => {
      probe.destroy()
      resolve(true)
    })
    probe.once('error', () => resolve(false))
  })
}

export class Portal {
  private server: Server | null = null
  private mirrorOpen = false

  constructor(
    private readonly path: string,
    private readonly deps: PortalDeps,
  ) {}

  async start(): Promise<boolean> {
    if (await isLiveSocket(this.path)) return false
    rmSync(this.path, { force: true })
    const server = createServer((socket) => this.serve(socket))
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.path, () => {
        server.off('error', reject)
        resolve()
      })
    })
    chmodSync(this.path, 0o600)
    server.on('error', (err) => console.error('[portal] socket server error:', err))
    return true
  }

  stop(): void {
    if (!this.server) return
    this.server.close()
    this.server = null
    rmSync(this.path, { force: true })
  }

  private serve(socket: Socket): void {
    const conn = createMessageConnection(
      new StreamMessageReader(socket),
      new StreamMessageWriter(socket),
    )
    let mirror: MirrorHandle | null = null
    let reserved = false
    let closed = false

    const release = (): void => {
      mirror?.detach()
      mirror = null
      if (reserved) this.mirrorOpen = false
      reserved = false
    }

    const close = (): void => {
      if (closed) return
      closed = true
      release()
      conn.dispose()
      socket.destroy()
    }

    conn.onRequest('portal.open', async (params: unknown): Promise<PortalOpenResult> => {
      const refused = verdictError(await this.deps.judge(socket))
      if (refused) throw refused
      if (reserved || this.mirrorOpen) {
        throw refuse('mirror-attached: another terminal is already showing the manager')
      }
      reserved = true
      this.mirrorOpen = true
      let result: PortalOpenResult
      try {
        const req = parseOpenRequest(params)
        const { info, created } = await this.deps.manager.open(req)
        result = { paneId: info.paneId, agent: info.agent, created }
        if (closed) {
          release()
          return result
        }
        const handle = this.deps.attachMirror(info.paneId, {
          data: (data) => void conn.sendNotification('mirror.data', { data }),
          exit: (code) => {
            void conn.sendNotification('mirror.exit', { code })
            setTimeout(close, 100)
          },
        })
        if (!handle) throw new ManagerError('manager-ended: the manager is no longer running')
        mirror = handle
        handle.resize(req.cols, req.rows)
      } catch (err) {
        release()
        if (err instanceof ManagerError) throw refuse(err.message)
        throw err
      }
      return result
    })

    conn.onNotification('mirror.input', (params: { data?: unknown }) => {
      if (typeof params?.data !== 'string' || params.data.length > MAX_INPUT_CHUNK) return
      mirror?.write(params.data)
    })

    conn.onNotification('mirror.resize', (params: { cols?: unknown; rows?: unknown }) => {
      const cols = Number(params?.cols)
      const rows = Number(params?.rows)
      if (!Number.isInteger(cols) || !Number.isInteger(rows)) return
      if (cols < 1 || rows < 1 || cols > 1000 || rows > 1000) return
      mirror?.resize(cols, rows)
    })

    socket.on('error', close)
    socket.on('close', close)
    conn.onClose(close)
    conn.listen()
  }
}
