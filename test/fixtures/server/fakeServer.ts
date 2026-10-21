import { createPublicKey, randomBytes, verify } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'

const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex')
const REGISTER_CONTEXT = 'ostia-server/register/v1'
const CHALLENGE_CONTEXT = 'ostia-server/auth/v1'
const RELAY_DOMAIN = 'relay.test'

interface FakeDevice {
  id: string
  accountId: string
  name: string
  signPub: string
}

interface FakeSession {
  deviceId: string
  expiresAt: number
}

interface Intercept {
  status: number
  body?: unknown
  headers?: Record<string, string>
}

interface Listener {
  ws: WebSocket
  deviceId: string
}

export interface PhoneStream {
  id: string
  received: () => Buffer
  send: (data: Buffer) => void
  accepted: Promise<void>
  closed: Promise<void>
  close: () => void
}

interface PendingStream {
  id: string
  deviceId: string
  ws: WebSocket | null
  chunks: Buffer[]
  accept: () => void
  closed: () => void
}

export interface FakeServerOptions {
  sessionTtlMs?: number
  pingMs?: number
  github?: boolean
}

function b64(buffer: Buffer): string {
  return buffer.toString('base64url')
}

function verifyEd25519(signPub: string, message: string, signature: string): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.concat([SPKI_ED25519, Buffer.from(signPub, 'base64url')]),
      format: 'der',
      type: 'spki',
    })
    return verify(null, Buffer.from(message, 'utf8'), key, Buffer.from(signature, 'base64url'))
  } catch {
    return false
  }
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

export class FakeServer {
  readonly invites = new Set<string>()
  readonly requests: string[] = []
  readonly confirmed: string[] = []
  readonly devices = new Map<string, FakeDevice>()
  readonly sessions = new Map<string, FakeSession>()
  readonly intercepts = new Map<string, Intercept[]>()
  githubPolls = 0
  githubPendingPolls = 1
  githubDenied = false
  pongs = 0
  challenges = 0
  listenerConnections = 0
  sessionTtlMs: number
  url = ''
  private readonly nonces = new Map<string, string>()
  private readonly http: Server
  private readonly sockets = new WebSocketServer({ noServer: true })
  private readonly listeners = new Map<string, Listener>()
  private readonly streams = new Map<string, PendingStream>()
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private nextDevice = 1

  constructor(private readonly options: FakeServerOptions = {}) {
    this.sessionTtlMs = options.sessionTtlMs ?? 3_600_000
    this.http = createServer((req, res) => void this.route(req, res))
    this.http.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head))
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.http.listen(0, '127.0.0.1', resolve))
    this.url = `http://127.0.0.1:${(this.http.address() as AddressInfo).port}`
    if (this.options.pingMs) {
      this.pingTimer = setInterval(() => this.pingListeners(), this.options.pingMs)
    }
    return this
  }

  async close(): Promise<void> {
    if (this.pingTimer) clearInterval(this.pingTimer)
    for (const client of this.sockets.clients) client.terminate()
    this.http.closeAllConnections()
    await new Promise<void>((resolve) => this.http.close(() => resolve()))
  }

  intercept(key: string, ...answers: Intercept[]): void {
    this.intercepts.set(key, answers)
  }

  listenerCount(): number {
    return this.listeners.size
  }

  expireSessions(): void {
    for (const session of this.sessions.values()) session.expiresAt = 0
  }

  dropListener(deviceId: string, code = 1008): void {
    this.listeners.get(deviceId)?.ws.close(code)
  }

  offer(message: Record<string, unknown>): void {
    const listener = [...this.listeners.values()][0]
    listener?.ws.send(JSON.stringify(message))
  }

  pausePhone(id: string): void {
    this.streams.get(id)?.ws?.pause()
  }

  private pingListeners(): void {
    for (const { ws } of this.listeners.values()) ws.send('{"t":"ping"}')
  }

  phoneConnect(peer: string, family: 4 | 6 = 4): PhoneStream {
    const listener = [...this.listeners.values()][0]
    if (!listener) throw new Error('no desktop is listening')
    const id = b64(randomBytes(9))
    let accept = (): void => {}
    let closed = (): void => {}
    const accepted = new Promise<void>((resolve) => {
      accept = resolve
    })
    const closedPromise = new Promise<void>((resolve) => {
      closed = resolve
    })
    const stream: PendingStream = {
      id,
      deviceId: listener.deviceId,
      ws: null,
      chunks: [],
      accept,
      closed,
    }
    this.streams.set(id, stream)
    listener.ws.send(JSON.stringify({ t: 'incoming', stream: id, peer, family }))
    return {
      id,
      received: () => Buffer.concat(stream.chunks),
      send: (data) => stream.ws?.send(data, { binary: true }),
      accepted,
      closed: closedPromise,
      close: () => stream.ws?.close(),
    }
  }

  private sessionOf(req: IncomingMessage): { token: string; session: FakeSession } | null {
    const header = req.headers.authorization ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    const session = this.sessions.get(token)
    return session && session.expiresAt > Date.now() ? { token, session } : null
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const auth = this.sessionOf(req)
    const path = req.url ?? ''
    this.requests.push(`UPGRADE ${path}`)
    if (!auth) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    this.sockets.handleUpgrade(req, socket, head, (ws) => {
      if (path === '/v1/relay/listen') this.attachListener(ws, auth.session.deviceId)
      else if (path.startsWith('/v1/relay/accept/')) {
        this.attachAccept(ws, path.slice('/v1/relay/accept/'.length), auth.session.deviceId)
      } else ws.close()
    })
  }

  private attachListener(ws: WebSocket, deviceId: string): void {
    this.listenerConnections += 1
    this.listeners.get(deviceId)?.ws.close(1008)
    const listener = { ws, deviceId }
    this.listeners.set(deviceId, listener)
    ws.on('message', (data) => {
      const message = JSON.parse(data.toString('utf8')) as { t?: string; stream?: string }
      if (message.t === 'pong') this.pongs += 1
      if (message.t === 'confirm' && message.stream) this.confirmed.push(message.stream)
    })
    ws.on('close', () => {
      if (this.listeners.get(deviceId) === listener) this.listeners.delete(deviceId)
    })
  }

  private attachAccept(ws: WebSocket, id: string, deviceId: string): void {
    const stream = this.streams.get(id)
    if (!stream || stream.deviceId !== deviceId || stream.ws) {
      ws.close(1008)
      return
    }
    stream.ws = ws
    ws.on('message', (data: Buffer) => stream.chunks.push(Buffer.from(data)))
    ws.on('close', () => stream.closed())
    stream.accept()
  }

  private reply(res: ServerResponse, status: number, body?: unknown, headers = {}): void {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
    res.end(body === undefined ? undefined : JSON.stringify(body))
  }

  private error(res: ServerResponse, status: number, code: string, headers = {}): void {
    this.reply(res, status, { error: code }, headers)
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const key = `${req.method} ${req.url}`
    this.requests.push(key)
    const queued = this.intercepts.get(key)?.shift()
    if (queued) {
      this.reply(res, queued.status, queued.body, queued.headers)
      return
    }
    const body = await readBody(req)
    const handler = this.handlers()[key]
    if (!handler) {
      this.error(res, 404, 'not-found')
      return
    }
    handler(req, res, body)
  }

  private register(res: ServerResponse, body: Record<string, unknown>, provider: string): void {
    const { name, signPub, boxPub, proof } = body as Record<string, string>
    const message = `${REGISTER_CONTEXT}\n${signPub}\n${boxPub}`
    if (!verifyEd25519(signPub, message, proof)) {
      this.error(res, 400, 'bad-proof')
      return
    }
    const id = `device${this.nextDevice++}`
    const accountId = `account${this.devices.size + 1}`
    this.devices.set(id, { id, accountId, name, signPub })
    this.reply(res, 201, { accountId, deviceId: id, provider })
  }

  private handlers(): Record<
    string,
    (req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) => void
  > {
    return {
      'GET /v1/info': (_req, res) =>
        this.reply(res, 200, {
          api: 1,
          modules: { relay: true, publish: true, sync: true, push: false },
          auth: { invite: true, github: this.options.github === true },
          relayDomain: RELAY_DOMAIN,
          shareDomain: 'shares.test',
          limits: {},
        }),
      'POST /v1/auth/invite': (_req, res, body) => {
        const code = String(body.code ?? '')
        if (!this.invites.delete(code)) {
          this.error(res, 403, 'invalid-invite')
          return
        }
        this.register(res, body, 'invite')
      },
      'POST /v1/auth/github/device': (_req, res) =>
        this.reply(res, 200, {
          flowId: 'flow1',
          userCode: 'ABCD-1234',
          verificationUri: 'https://github.test/login/device',
          interval: 0,
          expiresIn: 900,
        }),
      'POST /v1/auth/github/poll': (_req, res, body) => {
        this.githubPolls += 1
        if (this.githubDenied) this.error(res, 403, 'denied')
        else if (this.githubPolls <= this.githubPendingPolls) {
          this.reply(res, 202, { status: 'pending', interval: 0 })
        } else this.register(res, body, 'github')
      },
      'POST /v1/auth/challenge': (_req, res, body) => {
        this.challenges += 1
        const nonce = b64(randomBytes(32))
        this.nonces.set(String(body.deviceId), nonce)
        this.reply(res, 200, { nonce })
      },
      'POST /v1/auth/verify': (_req, res, body) => {
        const deviceId = String(body.deviceId)
        const device = this.devices.get(deviceId)
        const nonce = this.nonces.get(deviceId)
        this.nonces.delete(deviceId)
        const message = `${CHALLENGE_CONTEXT}\n${deviceId}\n${nonce}`
        if (!device || !nonce || body.nonce !== nonce) {
          this.error(res, 401, 'unauthorized')
          return
        }
        if (!verifyEd25519(device.signPub, message, String(body.sig))) {
          this.error(res, 401, 'unauthorized')
          return
        }
        const token = b64(randomBytes(24))
        const expiresAt = Date.now() + this.sessionTtlMs
        this.sessions.set(token, { deviceId, expiresAt })
        this.reply(res, 200, { token, expiresAt, accountId: device.accountId })
      },
      'DELETE /v1/auth/session': (req, res) => {
        const auth = this.sessionOf(req)
        if (auth) this.sessions.delete(auth.token)
        res.writeHead(204).end()
      },
      'GET /v1/devices': (req, res) => {
        const auth = this.sessionOf(req)
        if (!auth) {
          this.error(res, 401, 'unauthorized')
          return
        }
        const mine = this.devices.get(auth.session.deviceId)
        const devices = [...this.devices.values()]
          .filter((d) => d.accountId === mine?.accountId)
          .map((d) => ({ id: d.id, name: d.name, lastSeen: 0, current: d.id === mine?.id }))
        this.reply(res, 200, { devices })
      },
      'POST /v1/relay/label': (req, res) => {
        const auth = this.sessionOf(req)
        if (!auth) {
          this.error(res, 401, 'unauthorized')
          return
        }
        const label = `lbl${auth.session.deviceId}`
        this.reply(res, 200, { label, host: `${label}.${RELAY_DOMAIN}`, port: 443 })
      },
    }
  }
}
