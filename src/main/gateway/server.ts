import type { IncomingMessage } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import {
  type AddressInfo,
  createServer as createNetServer,
  type Server as NetServer,
  type Socket,
} from 'node:net'
import { createSecureContext, TLSSocket } from 'node:tls'
import { isEqual } from 'es-toolkit'
import { type WebSocket, WebSocketServer } from 'ws'
import type { GatewayPhoneAddress } from '../../shared/gateway/gatewayApi'
import { PLATFORM_EVENT_TYPES, type PlatformEventType, platformEvents } from '../control/events'
import { getByPaneId } from '../control/idRegistry'
import { type GatewayAddress, gatewayAddresses, isCurrentHost, type TailnetNode } from './addresses'
import { type GatewayCert, getCert } from './cert'
import type { GatewayControlDeps } from './controlDispatch'
import { get as getDevice, list as listDevices, touchDevice } from './devices'
import { createPairHttp } from './pairHttp'
import { createPhoneSocket, PHONE_FRAME_BYTES, type SocketState } from './phoneSocket'
import { closeStreams } from './phoneStream'
import { type ProxyPeer, readProxyHeader } from './proxyProtocol'
import type { ScreenLinks } from './screenLinks'
import type { ScreenRequested } from './screenRequests'

export interface GatewayStartOptions {
  host?: string
  port?: number
  tailnet?: boolean
  phoneAddress?: GatewayPhoneAddress | null
  relay?: boolean
}

export interface RelayPeers {
  owns: (peer: ProxyPeer) => boolean
  accepted: (peer: ProxyPeer) => void
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
const proxyPeers = new WeakMap<object, ProxyPeer>()
let tailnetNode: TailnetNode | null = null
let relayHost: string | null = null
let relayPeers: RelayPeers | null = null
let phoneAddress: GatewayPhoneAddress | null = null
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
  touchDevice(deviceId)
}

function untrackDeviceSocket(deviceId: string, ws: WebSocket): void {
  const set = socketsByDevice.get(deviceId)
  if (!set) return
  set.delete(ws)
  if (set.size > 0) return
  socketsByDevice.delete(deviceId)
  touchDevice(deviceId)
  screenLinks?.deviceGone(deviceId)
}

function releaseSocket(state: SocketState): void {
  state.ptyAttachment?.detach()
  state.ptyAttachment = null
  closeStreams(state)
}

export function closeDeviceSockets(deviceId: string): void {
  const set = socketsByDevice.get(deviceId)
  if (!set) return
  for (const ws of set) {
    const state = sockets.get(ws)
    if (state) releaseSocket(state)
    ws.close(4003, 'revoked')
  }
  socketsByDevice.delete(deviceId)
  screenLinks?.deviceGone(deviceId)
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
      releaseSocket(state)
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
    if (!state.device?.caps.includes(cap)) continue
    if (ws.readyState === ws.OPEN) ws.send(frame)
  }
}

function notifiedSockets(): Array<[WebSocket, string]> {
  const found: Array<[WebSocket, string]> = []
  for (const [ws, state] of sockets) {
    if (!state.device?.caps.includes('notify') || screenLinks?.isLink(ws)) continue
    if (ws.readyState === ws.OPEN) found.push([ws, state.device.deviceId])
  }
  return found
}

export function notifiedDeviceIds(): string[] {
  return [...new Set(notifiedSockets().map(([, deviceId]) => deviceId))]
}

export function askPhonesForScreen(request: ScreenRequested, deviceIds?: string[]): void {
  const frame = eventFrame('screen.requested', request)
  for (const [ws, deviceId] of notifiedSockets()) {
    if (!deviceIds || deviceIds.includes(deviceId)) ws.send(frame)
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
let screenLinks: ScreenLinks | null = null

export function configureGatewayControl(deps: GatewayControlDeps): void {
  controlDeps = deps
}

export function configureScreenLinks(links: ScreenLinks): void {
  screenLinks = links
}

function hasBrowserOrigin(origin: string | undefined): boolean {
  return typeof origin === 'string' && origin.length > 0
}

function currentAddresses(): GatewayAddress[] {
  return gatewayAddresses({
    port: boundPort,
    bindHost: boundHost,
    tailnet: tailnetNode,
    phoneAddress,
    relayHost,
  })
}

function isAllowedHostHeader(hostHeader: string | undefined): boolean {
  return isCurrentHost(hostHeader, boundPort, currentAddresses())
}

export function setTailnetNode(node: TailnetNode | null): void {
  changeAddresses(() => {
    tailnetNode = node
  })
}

export function setRelayHost(host: string | null): void {
  changeAddresses(() => {
    relayHost = host
  })
}

function changeAddresses(change: () => void): void {
  const before = currentAddresses()
  change()
  const after = currentAddresses()
  if (isEqual(before, after)) return
  const frame = eventFrame('addresses.changed', { addresses: after })
  for (const [ws, state] of sockets) {
    if (!state.device || screenLinks?.isLink(ws)) continue
    if (ws.readyState === ws.OPEN) ws.send(frame)
  }
}

function peerAddress(socket: object & { remoteAddress?: string }): string {
  return proxyPeers.get(socket)?.ip ?? socket.remoteAddress ?? 'unknown'
}

export function configureRelayPeers(peers: RelayPeers | null): void {
  relayPeers = peers
}

function isRelayed(socket: object): boolean {
  const peer = proxyPeers.get(socket)
  return peer !== undefined && relayPeers?.owns(peer) === true
}

function relayVia(socket: object): 'relay' | undefined {
  return isRelayed(socket) ? 'relay' : undefined
}

function phoneAccepted(socket: object): void {
  const peer = proxyPeers.get(socket)
  if (peer && isRelayed(socket)) relayPeers?.accepted(peer)
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
      proxyPeers.set(tls, peer)
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
  via: relayVia,
  accepted: phoneAccepted,
  fingerprint: () => currentFingerprint,
  isAllowedHostHeader,
  hasBrowserOrigin,
})

const handleConnection = createPhoneSocket({
  sockets,
  trackDeviceSocket,
  untrackDeviceSocket,
  controlDeps: () => controlDeps,
  screenLinks: () => screenLinks,
  addresses: currentAddresses,
  accepted: phoneAccepted,
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
    maxPayload: PHONE_FRAME_BYTES,
    verifyClient: (info: { origin: string; req: IncomingMessage }) =>
      !hasBrowserOrigin(info.origin) && isAllowedHostHeader(info.req.headers.host),
  })
  wsServer.on('connection', (ws, req) => handleConnection(ws, req.socket))
  server.on('error', (err) => console.error('[gateway] server error:', err))

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const helper =
    options.tailnet === false && options.relay !== true ? null : await listenHelper(server, cert)

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
  tailnetNode = null
  relayHost = null
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
