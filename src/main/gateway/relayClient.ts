import { connect, isIP } from 'node:net'
import { pipeline } from 'node:stream'
import { createWebSocketStream, WebSocket } from 'ws'
import type { GatewayPhoneAddress, GatewayRelayState } from '../../shared/gateway/gatewayApi'
import { failureOf, type ServerAccount } from '../server/serverAccount'
import type { Session } from '../server/serverSession'
import { socketOrigin } from '../server/serverUrl'
import type { ProxyPeer } from './proxyProtocol'

const BACKOFF_MIN_MS = 1000
const BACKOFF_MAX_MS = 60_000
const REDIAL_LEAD_MS = 120_000
const REDIAL_RETRY_MS = 10_000
const SILENCE_MS = 120_000
const DIAL_TIMEOUT_MS = 10_000
const MAX_STREAMS = 64
const LOOPBACK = '127.0.0.1'
const STREAM_ID = /^[A-Za-z0-9_-]{1,64}$/

type RelayAccount = Pick<
  ServerAccount,
  'signedIn' | 'onChange' | 'baseUrl' | 'relayLabel' | 'session' | 'devicesChanged'
>

export interface RelayDeps {
  account: RelayAccount
  helperPort: () => number | null
  onState: (state: GatewayRelayState) => void
  onAddress: (address: GatewayPhoneAddress | null) => void
  random?: () => number
  now?: () => number
}

interface Listener {
  ws: WebSocket
  token: string
  silence: ReturnType<typeof setTimeout> | null
  redial: ReturnType<typeof setTimeout> | null
}

interface RelayedStream {
  id: string
  confirmed: boolean
  ws: WebSocket
}

interface Incoming {
  t?: unknown
  stream?: unknown
  peer?: unknown
  family?: unknown
}

function validLabel(found: { label: string; host: string; port: number }): {
  label: string
  host: string
  port: number
} {
  const { label, host, port } = found
  if (
    typeof label !== 'string' ||
    label === '' ||
    typeof host !== 'string' ||
    host === '' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error('bad-label')
  }
  return { label, host, port }
}

function clearTimers(listener: Listener): void {
  if (listener.silence) clearTimeout(listener.silence)
  if (listener.redial) clearTimeout(listener.redial)
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Unexpected server response: 401')
}

function peerKey(ip: string, port: number): string {
  return `${ip}:${port}`
}

function parsePeer(peer: unknown, family: unknown): ProxyPeer | null {
  if (typeof peer !== 'string') return null
  const sep = peer.lastIndexOf(':')
  if (sep <= 0) return null
  const ip = peer.slice(0, sep).replace(/^\[|\]$/g, '')
  const port = Number(peer.slice(sep + 1))
  const version = family === 4 || family === 6 ? family : 0
  if (version === 0 || isIP(ip) !== version) return null
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? { ip, port } : null
}

function proxyLine({ ip, port }: ProxyPeer): string {
  const family = isIP(ip) === 6 ? 'TCP6' : 'TCP4'
  return `PROXY ${family} ${ip} ${LOOPBACK} ${port} ${port}\r\n`
}

export class RelayClient {
  private running = false
  private state: GatewayRelayState = { state: 'off' }
  private listener: Listener | null = null
  private streams = new Map<string, RelayedStream>()
  private label: { label: string; host: string; port: number } | null = null
  private generation = 0
  private backoff = BACKOFF_MIN_MS
  private retry: ReturnType<typeof setTimeout> | null = null
  private unsubscribe: (() => void) | null = null
  private connecting = false

  constructor(private readonly deps: RelayDeps) {}

  status(): GatewayRelayState {
    return this.state
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.unsubscribe = this.deps.account.onChange(() => this.sync())
    this.sync()
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    this.unsubscribe?.()
    this.unsubscribe = null
    this.teardown()
    this.setLabel(null)
    this.setState({ state: 'off' })
  }

  owns(peer: ProxyPeer): boolean {
    return this.streams.has(peerKey(peer.ip, peer.port))
  }

  accepted(peer: ProxyPeer): void {
    const stream = this.streams.get(peerKey(peer.ip, peer.port))
    const control = this.listener?.ws
    if (!stream || stream.confirmed || control?.readyState !== WebSocket.OPEN) return
    stream.confirmed = true
    control.send(JSON.stringify({ t: 'confirm', stream: stream.id }))
  }

  private setState(state: GatewayRelayState): void {
    this.state = state
    this.deps.onState(state)
  }

  private setLabel(label: { label: string; host: string; port: number } | null): void {
    this.label = label
    this.deps.onAddress(label ? { host: label.host, port: label.port } : null)
  }

  private sync(): void {
    if (!this.running) return
    if (!this.deps.account.signedIn()) {
      this.teardown()
      this.setLabel(null)
      this.setState({ state: 'needs-sign-in' })
      return
    }
    if (this.listener === null && !this.connecting && this.retry === null) void this.connect()
  }

  private teardown(): void {
    this.generation += 1
    this.connecting = false
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    this.dropListener()
    for (const stream of this.streams.values()) stream.ws.terminate()
    this.streams.clear()
  }

  private dropListener(): void {
    const listener = this.listener
    this.listener = null
    if (!listener) return
    clearTimers(listener)
    listener.ws.terminate()
  }

  private async connect(): Promise<void> {
    const generation = this.generation
    this.connecting = true
    this.setState({ state: 'connecting' })
    try {
      const { account } = this.deps
      if (!this.label) {
        const found = await account.relayLabel()
        if (generation !== this.generation) return
        this.setLabel(validLabel(found))
      }
      const session = await account.session().ensure()
      if (generation !== this.generation) return
      await this.dialFresh(session, generation)
    } catch (error) {
      if (generation !== this.generation) return
      this.connecting = false
      this.failed(failureOf(error))
    }
  }

  private async dialFresh(session: Session, generation: number): Promise<void> {
    try {
      await this.dial(session, generation)
    } catch (error) {
      if (!isUnauthorized(error)) throw error
      await this.dial(await this.deps.account.session().renew(session.token), generation)
    }
  }

  private failed(code: string): void {
    if (code === 'not-signed-in') {
      this.setState({ state: 'needs-sign-in' })
      return
    }
    this.setState({ state: 'error', code })
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (!this.running || this.retry) return
    const random = this.deps.random ?? Math.random
    const delay = Math.round(this.backoff * (0.5 + random() / 2))
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS)
    this.retry = setTimeout(() => {
      this.retry = null
      this.sync()
    }, delay)
  }

  private authHeaders(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}` }
  }

  private socketUrl(path: string): string {
    const origin = this.deps.account.baseUrl()
    if (!origin) throw new Error('no-server')
    return `${socketOrigin(origin)}${path}`
  }

  private dial(session: Session, generation: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.socketUrl('/v1/relay/listen'), {
        headers: this.authHeaders(session.token),
        handshakeTimeout: DIAL_TIMEOUT_MS,
      })
      ws.once('error', reject)
      ws.once('open', () => {
        ws.off('error', reject)
        if (generation !== this.generation) {
          ws.terminate()
          resolve()
          return
        }
        this.adopt(ws, session, generation)
        resolve()
      })
    })
  }

  private adopt(ws: WebSocket, session: Session, generation: number): void {
    const previous = this.listener
    const listener: Listener = { ws, token: session.token, silence: null, redial: null }
    this.listener = listener
    this.connecting = false
    this.backoff = BACKOFF_MIN_MS
    if (previous) {
      clearTimers(previous)
      previous.ws.close()
    }
    const listenSilence = (): void => {
      if (listener.silence) clearTimeout(listener.silence)
      listener.silence = setTimeout(() => ws.terminate(), SILENCE_MS)
    }
    listenSilence()
    const now = this.deps.now ?? Date.now
    const lead = Math.max(REDIAL_RETRY_MS, session.expiresAt - now() - REDIAL_LEAD_MS)
    listener.redial = setTimeout(() => void this.redial(listener, generation), lead)
    ws.on('message', (data, isBinary) => {
      listenSilence()
      if (!isBinary) this.onControl(ws, data.toString('utf8'))
    })
    ws.on('error', () => ws.terminate())
    ws.on('close', () => {
      if (this.listener !== listener) return
      this.dropListener()
      this.setState({ state: 'connecting' })
      this.scheduleReconnect()
    })
    this.setState({ state: 'listening', host: this.label?.host ?? '', port: this.label?.port ?? 0 })
  }

  private async redial(listener: Listener, generation: number): Promise<void> {
    if (this.listener !== listener || generation !== this.generation) return
    try {
      const session = await this.deps.account.session().renew(listener.token)
      if (this.listener !== listener || generation !== this.generation) return
      await this.dial(session, generation)
    } catch {
      if (this.listener !== listener) return
      listener.redial = setTimeout(() => void this.redial(listener, generation), REDIAL_RETRY_MS)
    }
  }

  private onControl(ws: WebSocket, text: string): void {
    let message: Incoming
    try {
      message = JSON.parse(text) as Incoming
    } catch {
      return
    }
    if (message.t === 'ping') {
      ws.send('{"t":"pong"}')
      return
    }
    if (message.t === 'device-added') {
      this.deps.account.devicesChanged()
      return
    }
    if (message.t !== 'incoming') return
    const peer = parsePeer(message.peer, message.family)
    if (peer && typeof message.stream === 'string' && STREAM_ID.test(message.stream)) {
      void this.accept(message.stream, peer)
    }
  }

  private async accept(id: string, peer: ProxyPeer): Promise<void> {
    const key = peerKey(peer.ip, peer.port)
    const helperPort = this.deps.helperPort()
    if (this.streams.has(key) || this.streams.size >= MAX_STREAMS || helperPort === null) return
    const generation = this.generation
    try {
      const { token } = await this.deps.account.session().ensure()
      if (generation !== this.generation || this.streams.has(key)) return
      const ws = new WebSocket(this.socketUrl(`/v1/relay/accept/${id}`), {
        headers: this.authHeaders(token),
        handshakeTimeout: DIAL_TIMEOUT_MS,
      })
      this.streams.set(key, { id, confirmed: false, ws })
      this.pipe(ws, key, peer, helperPort)
    } catch {
      this.streams.delete(key)
    }
  }

  private pipe(ws: WebSocket, key: string, peer: ProxyPeer, helperPort: number): void {
    const remote = createWebSocketStream(ws)
    const local = connect({ host: LOOPBACK, port: helperPort })
    const end = (): void => {
      remote.destroy()
      local.destroy()
      ws.terminate()
      if (this.streams.get(key)?.ws === ws) this.streams.delete(key)
    }
    local.write(proxyLine(peer))
    pipeline(remote, local, end)
    pipeline(local, remote, end)
  }
}
