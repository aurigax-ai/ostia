import type { IncomingMessage } from 'node:http'
import { type Server as HttpsServer, createServer as createHttpsServer } from 'node:https'
import {
  type AddressInfo,
  type Server as NetServer,
  type Socket,
  createServer as createNetServer,
} from 'node:net'
import { TLSSocket, createSecureContext } from 'node:tls'
import { type WebSocket, WebSocketServer } from 'ws'
import type { GatewayPhoneAddress } from '../../shared/gateway/gatewayApi'
import { PLATFORM_EVENT_TYPES, type PlatformEventType, platformEvents } from '../control/events'
import { getByPaneId } from '../control/idRegistry'
import { type GatewayCert, getCert } from './cert'
import type { GatewayControlDeps } from './controlDispatch'
import { get as getDevice, list as listDevices } from './devices'
import { createPairHttp } from './pairHttp'
import { type SocketState, createPhoneSocket } from './phoneSocket'
import { readProxyHeader } from './proxyProtocol'

export interface GatewayStartOptions {
  host?: string
  port?: number
  tailnet?: boolean
  phoneAddress?: GatewayPhoneAddress | null
}

export interface GatewayStartResult {
  host: string
  port: number
  helperPort: number | null
  fingerprint: string
}

export interface GatewayStatus {
  running: boolean
  host: string | null
  port: number | null
  fingerprint: string | null
  deviceCount: number
}

const DEFAULT_PORT = 8722
const LOOPBACK = '127.0.0.1'
const HEARTBEAT_MS = 15_000

let httpsServer: HttpsServer | null = null
let helperServer: NetServer | null = null
const helperSockets = new Set<Socket>()
const tailnetPeers = new WeakMap<object, string>()
let tailnetHosts: ReadonlySet<string> = new Set()
let phoneAddress: GatewayPhoneAddress | null = null
const MAX_FRAME_BYTES = 1024 * 1024

let wss: WebSocketServer | null = null
let heartbeat: ReturnType<typeof setInterval> | null = null
let boundHost: string | null = null
let boundPort: number | null = null
let boundHelperPort: number | null = null
let currentFingerprint: string | null = null

const sockets = new Map<WebSocket, SocketState>()

const socketsByDevice = new Map<string, Set<WebSocket>>()

function trackDeviceSocket(deviceId: string, ws: WebSocket): void {
  let set = socketsByDevice.get(deviceId)
  if (!set) {
    set = new Set()
    socketsByDevice.set(deviceId, set)
  }
  set.add(ws)
}

function untrackDeviceSocket(deviceId: string, ws: WebSocket): void {
  const set = socketsByDevice.get(deviceId)
  if (!set) return
  set.delete(ws)
  if (set.size === 0) socketsByDevice.delete(deviceId)
}

export function closeDeviceSockets(deviceId: string): void {
  const set = socketsByDevice.get(deviceId)
  if (!set) return
  for (const ws of set) ws.close(4003, 'revoked')
  socketsByDevice.delete(deviceId)
}

function eventFrame(type: string, payload: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type, payload } })
}

export function applyDeviceCaps(deviceId: string, caps: string[]): void {
  const set = socketsByDevice.get(deviceId)
  if (!set) return
  for (const ws of [...set]) {
    const state = sockets.get(ws)
    if (!state?.device) continue
    const lost = state.device.caps.some((c) => !caps.includes(c))
    state.device = { ...state.device, caps: [...caps] }
    if (lost) {
      state.ptyAttachment?.detach()
      state.ptyAttachment = null
      ws.close(4004, 'caps-changed')
    } else if (ws.readyState === ws.OPEN) {
      ws.send(eventFrame('caps.changed', { caps }))
    }
  }
}

const NOTIFY_CAP_EVENTS: ReadonlySet<PlatformEventType> = new Set([
  'notify',
  'agent.needs-input',
  'agent.done',
])

export function capForPlatformEvent(type: PlatformEventType): string {
  return NOTIFY_CAP_EVENTS.has(type) ? 'notify' : 'read'
}

function phonePayload(type: PlatformEventType, payload: unknown): unknown {
  if (type !== 'notify' || !payload || typeof payload !== 'object') return payload
  const { from, ...rest } = payload as { from?: unknown }
  const external = typeof from === 'string' ? (getByPaneId(from)?.externalId ?? null) : null
  return { ...rest, from: external }
}

function broadcastEvent(type: PlatformEventType, payload: unknown): void {
  const cap = capForPlatformEvent(type)
  const frame = eventFrame(type, phonePayload(type, payload))
  for (const [ws, state] of sockets) {
    if (!state.device || !state.device.caps.includes(cap)) continue
    if (ws.readyState === ws.OPEN) ws.send(frame)
  }
}

export function phoneCanRespond(): boolean {
  for (const [ws, state] of sockets) {
    const device = state.device ? getDevice(state.device.deviceId) : null
    if (device?.caps.includes('respond') && ws.readyState === ws.OPEN) return true
  }
  return false
}

let eventSubscriptions: Array<{ type: PlatformEventType; listener: (payload: unknown) => void }> =
  []

function subscribePlatformEvents(): void {
  for (const type of PLATFORM_EVENT_TYPES) {
    const listener = (payload: unknown): void => broadcastEvent(type, payload)
    platformEvents.on(type, listener)
    eventSubscriptions.push({ type, listener })
  }
}

function unsubscribePlatformEvents(): void {
  for (const { type, listener } of eventSubscriptions) platformEvents.off(type, listener)
  eventSubscriptions = []
}

let controlDeps: GatewayControlDeps | null = null

export function configureGatewayControl(deps: GatewayControlDeps): void {
  controlDeps = deps
}

function hasBrowserOrigin(origin: string | undefined): boolean {
  return typeof origin === 'string' && origin.length > 0
}

function isAllowedHostHeader(hostHeader: string | undefined): boolean {
  if (!boundPort || typeof hostHeader !== 'string' || !hostHeader) return false
  const sepIdx = hostHeader.lastIndexOf(':')
  const headerHost = sepIdx === -1 ? hostHeader : hostHeader.slice(0, sepIdx)
  const headerPort = sepIdx === -1 ? undefined : hostHeader.slice(sepIdx + 1)
  if (
    phoneAddress &&
    headerHost.toLowerCase() === phoneAddress.host.toLowerCase() &&
    (headerPort === undefined || Number(headerPort) === phoneAddress.port)
  ) {
    return true
  }
  if (headerPort !== undefined && Number(headerPort) !== boundPort) return false
  return (
    headerHost === LOOPBACK ||
    headerHost === 'localhost' ||
    headerHost === boundHost ||
    tailnetHosts.has(headerHost)
  )
}

export function setTailnetHosts(hosts: string[]): void {
  tailnetHosts = new Set(hosts.filter((h) => h.length > 0))
}

function peerAddress(socket: object & { remoteAddress?: string }): string {
  return tailnetPeers.get(socket) ?? socket.remoteAddress ?? 'unknown'
}

function startHeartbeat(): void {
  heartbeat = setInterval(() => {
    for (const [ws, state] of sockets) {
      if (!state.alive) {
        ws.terminate()
        continue
      }
      state.alive = false
      ws.ping()
    }
  }, HEARTBEAT_MS)
}

function listenHelper(server: HttpsServer, cert: GatewayCert): Promise<NetServer> {
  const secureContext = createSecureContext({ cert: cert.cert, key: cert.key })
  const helper = createNetServer((socket) => {
    helperSockets.add(socket)
    socket.on('close', () => helperSockets.delete(socket))
    readProxyHeader(socket, (peer, stream) => {
      const tls = new TLSSocket(stream as unknown as Socket, {
        isServer: true,
        server,
        secureContext,
      })
      tailnetPeers.set(tls, peer)
      tls.on('error', () => tls.destroy())
      tls.once('secure', () => server.emit('secureConnection', tls))
    })
  })
  return new Promise((resolve, reject) => {
    helper.once('error', reject)
    helper.listen(0, LOOPBACK, () => {
      helper.removeListener('error', reject)
      resolve(helper)
    })
  })
}

const requestHandler = createPairHttp({
  peerAddress,
  fingerprint: () => currentFingerprint,
  isAllowedHostHeader,
  hasBrowserOrigin,
})

const handleConnection = createPhoneSocket({
  sockets,
  trackDeviceSocket,
  untrackDeviceSocket,
  controlDeps: () => controlDeps,
})

export async function startGateway(options: GatewayStartOptions = {}): Promise<GatewayStartResult> {
  if (httpsServer) await stopGateway()

  const cert: GatewayCert = await getCert()
  const host = options.host ?? LOOPBACK
  const port = options.port ?? DEFAULT_PORT

  const server = createHttpsServer({ cert: cert.cert, key: cert.key }, requestHandler)
  const wsServer = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: MAX_FRAME_BYTES,
    verifyClient: (info: { origin: string; req: IncomingMessage }) =>
      !hasBrowserOrigin(info.origin) && isAllowedHostHeader(info.req.headers.host),
  })
  wsServer.on('connection', handleConnection)
  server.on('error', (err) => console.error('[gateway] server error:', err))

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const helper = options.tailnet === false ? null : await listenHelper(server, cert)

  httpsServer = server
  helperServer = helper
  wss = wsServer
  boundHost = host
  boundPort = (server.address() as AddressInfo).port
  boundHelperPort = helper ? (helper.address() as AddressInfo).port : null
  phoneAddress = options.phoneAddress ?? null
  currentFingerprint = cert.fingerprint
  startHeartbeat()
  subscribePlatformEvents()

  return {
    host,
    port: boundPort,
    helperPort: boundHelperPort,
    fingerprint: cert.fingerprint,
  }
}

export async function stopGateway(): Promise<void> {
  unsubscribePlatformEvents()
  if (heartbeat) {
    clearInterval(heartbeat)
    heartbeat = null
  }
  for (const ws of sockets.keys()) ws.terminate()
  sockets.clear()
  socketsByDevice.clear()
  for (const socket of helperSockets) socket.destroy()
  helperSockets.clear()

  const wssToClose = wss
  const httpsToClose = httpsServer
  const helperToClose = helperServer
  wss = null
  httpsServer = null
  helperServer = null
  boundHost = null
  boundPort = null
  boundHelperPort = null
  currentFingerprint = null
  tailnetHosts = new Set()
  phoneAddress = null

  if (wssToClose) await new Promise<void>((resolve) => wssToClose.close(() => resolve()))
  if (helperToClose) await new Promise<void>((resolve) => helperToClose.close(() => resolve()))
  if (httpsToClose) await new Promise<void>((resolve) => httpsToClose.close(() => resolve()))
}

export function gatewayHelperPort(): number | null {
  return boundHelperPort
}

export function gatewayStatus(): GatewayStatus {
  return {
    running: httpsServer !== null,
    host: boundHost,
    port: boundPort,
    fingerprint: currentFingerprint,
    deviceCount: listDevices().length,
  }
}
