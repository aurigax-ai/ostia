import type { IncomingMessage, ServerResponse } from 'node:http'
import { type Server as HttpsServer, createServer as createHttpsServer } from 'node:https'
import {
  type AddressInfo,
  type Server as NetServer,
  type Socket,
  createServer as createNetServer,
} from 'node:net'
import { TLSSocket, createSecureContext } from 'node:tls'
import { app } from 'electron'
import { type WebSocket, WebSocketServer } from 'ws'
import { PRODUCT_NAME } from '../../shared/product'
import type { GatewayPhoneAddress } from '../../shared/types'
import { PLATFORM_EVENT_TYPES, type PlatformEventType, platformEvents } from '../events'
import { getByPaneId, resolveExternal } from '../idRegistry'
import { type GatewayCert, getCert } from './cert'
import { type GatewayControlDeps, dispatchGatewayMethod } from './controlDispatch'
import { type Device, get as getDevice, list as listDevices, verifyToken } from './devices'
import { cancelPairRequest, openPairRequest, revealPairRequest } from './pairRequests'
import { auditPairAttempt, checkPairRateLimit, consumeCode, isLiveCode } from './pairing'
import { readProxyHeader } from './proxyProtocol'

const FRAME_PTY_OUTPUT = 0x01
const FRAME_PTY_INPUT = 0x02
const FRAME_PTY_RESIZE = 0x03
const MAX_PTY_DIM = 1000

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
const HELLO_TIMEOUT_MS = 10_000
const MAX_FRAME_BYTES = 1024 * 1024

let wss: WebSocketServer | null = null
let heartbeat: ReturnType<typeof setInterval> | null = null
let boundHost: string | null = null
let boundPort: number | null = null
let boundHelperPort: number | null = null
let currentFingerprint: string | null = null

interface PtyAttachment {
  rendererPaneId: string
  canWrite: boolean
  detach: () => void
}

interface SocketState {
  device: Device | null
  alive: boolean
  ptyAttachment: PtyAttachment | null
}
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

function refreshDevice(state: SocketState): Device | null {
  if (!state.device) return null
  const fresh = getDevice(state.device.deviceId)
  if (fresh) state.device = fresh
  return fresh
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

export function broadcastEvent(type: PlatformEventType, payload: unknown): void {
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

function rpcResult(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result })
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): string {
  const error: { code: number; message: string; data?: unknown } = { code, message }
  if (data !== undefined) error.data = data
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error })
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

function readJsonBody(req: IncomingMessage, maxBytes = 16_384): Promise<unknown> {
  return new Promise((resolve) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        resolve(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null)
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
  })
  res.end(data)
}

const COMMIT = /^[0-9a-f]{64}$/

async function handlePair(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ip = peerAddress(req.socket)
  if (!checkPairRateLimit(ip)) {
    auditPairAttempt(ip, 'rate-limited')
    sendJson(res, 429, { error: 'rate-limited' })
    return
  }
  const body = (await readJsonBody(req)) as {
    pairCode?: unknown
    device?: { name?: unknown; pubkey?: unknown }
    commit?: unknown
  } | null
  const pairCode = body?.pairCode
  const device = body?.device
  if (
    typeof pairCode !== 'string' ||
    !device ||
    typeof device.name !== 'string' ||
    typeof device.pubkey !== 'string'
  ) {
    auditPairAttempt(ip, 'bad-request')
    sendJson(res, 400, {
      error: 'bad-request',
      message: 'expected { pairCode, device: { name, pubkey }, commit }',
    })
    return
  }
  if (!isLiveCode(pairCode)) {
    auditPairAttempt(ip, 'invalid-code')
    sendJson(res, 401, { error: 'invalid-pair-code' })
    return
  }
  if (typeof body?.commit !== 'string' || !COMMIT.test(body.commit)) {
    auditPairAttempt(ip, 'bad-request')
    sendJson(res, 400, { error: 'bad-request', message: 'commit must be 64 hex characters' })
    return
  }
  consumeCode(pairCode)
  const { requestId, desktopNonce } = openPairRequest({
    name: device.name,
    pubkey: device.pubkey,
    commit: body.commit,
    peer: ip,
  })
  sendJson(res, 200, { requestId, nonce: desktopNonce })
}

async function handlePairConfirm(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readJsonBody(req)) as { requestId?: unknown; nonce?: unknown } | null
  if (typeof body?.requestId !== 'string' || typeof body.nonce !== 'string') {
    sendJson(res, 400, { error: 'bad-request', message: 'expected { requestId, nonce }' })
    return
  }
  const requestId = body.requestId
  const outcome = revealPairRequest(
    requestId,
    body.nonce,
    currentFingerprint ?? '',
    (status, reply) => sendJson(res, status, reply),
  )
  if (outcome === 'unknown-request') {
    sendJson(res, 404, { error: 'unknown-request' })
    return
  }
  if (outcome === 'commit-mismatch') {
    sendJson(res, 400, { error: 'commit-mismatch' })
    return
  }
  res.on('close', () => {
    if (!res.writableEnded) cancelPairRequest(requestId)
  })
}

function requestHandler(req: IncomingMessage, res: ServerResponse): void {
  if (hasBrowserOrigin(req.headers.origin)) {
    sendJson(res, 403, { error: 'origin-not-allowed' })
    return
  }
  if (!isAllowedHostHeader(req.headers.host)) {
    sendJson(res, 403, { error: 'host-not-allowed' })
    return
  }
  if (req.method === 'POST' && req.url === '/pair') {
    handlePair(req, res).catch(() => sendJson(res, 500, { error: 'internal-error' }))
    return
  }
  if (req.method === 'POST' && req.url === '/pair/confirm') {
    handlePairConfirm(req, res).catch(() => sendJson(res, 500, { error: 'internal-error' }))
    return
  }
  sendJson(res, 404, { error: 'not-found' })
}

function handleHello(
  ws: WebSocket,
  state: SocketState,
  msg: { id?: unknown; params?: unknown },
): void {
  const params = (msg.params ?? {}) as { deviceToken?: unknown }
  const device = typeof params.deviceToken === 'string' ? verifyToken(params.deviceToken) : null
  if (!device) {
    ws.send(rpcError(msg.id, -32001, 'unauthenticated'))
    ws.close(4001, 'unauthenticated')
    return
  }
  state.device = device
  trackDeviceSocket(device.deviceId, ws)
  ws.send(
    rpcResult(msg.id, {
      deviceId: device.deviceId,
      caps: device.caps,
      desktop: { name: PRODUCT_NAME, version: app.getVersion() },
    }),
  )
}

function handleWhoami(ws: WebSocket, device: Device, msg: { id?: unknown }): void {
  ws.send(rpcResult(msg.id, { deviceId: device.deviceId, caps: device.caps }))
}

function handleDeviceCaps(ws: WebSocket, device: Device, msg: { id?: unknown }): void {
  ws.send(rpcResult(msg.id, { caps: device.caps }))
}

function handleControlMethod(
  ws: WebSocket,
  device: Device,
  msg: { id?: unknown; method?: unknown; params?: unknown },
): void {
  if (!controlDeps) {
    ws.send(rpcError(msg.id, -32603, 'gateway control API not configured'))
    return
  }
  dispatchGatewayMethod(String(msg.method), msg.params, device.caps, controlDeps)
    .then((outcome) => {
      if (outcome.ok) ws.send(rpcResult(msg.id, outcome.result))
      else ws.send(rpcError(msg.id, outcome.code, outcome.message, outcome.data))
    })
    .catch((err) => {
      ws.send(rpcError(msg.id, -32603, err instanceof Error ? err.message : 'internal error'))
    })
}

function ptyOutputFrame(data: string): Buffer {
  return Buffer.concat([Buffer.from([FRAME_PTY_OUTPUT]), Buffer.from(data, 'utf8')])
}

function handlePtyAttach(
  ws: WebSocket,
  state: SocketState,
  device: Device,
  msg: { id?: unknown; params?: unknown },
): void {
  if (!controlDeps) {
    ws.send(rpcError(msg.id, -32603, 'gateway control API not configured'))
    return
  }
  if (!device.caps.includes('read')) {
    ws.send(rpcError(msg.id, -32003, 'needs-elevation', { cap: 'read' }))
    return
  }
  const p = (msg.params ?? {}) as { paneId?: unknown; role?: unknown; sinceCursor?: unknown }
  if (typeof p.paneId !== 'string' || !p.paneId) {
    ws.send(rpcError(msg.id, -32602, 'missing paneId'))
    return
  }
  const identity = resolveExternal(p.paneId)
  if (!identity) {
    ws.send(rpcError(msg.id, -32602, 'unknown paneId'))
    return
  }
  const wantsOwner = p.role === 'owner'
  const role: 'observer' | 'owner' =
    wantsOwner && device.caps.includes('input') ? 'owner' : 'observer'
  const sinceCursor = typeof p.sinceCursor === 'number' ? p.sinceCursor : 0

  state.ptyAttachment?.detach()
  state.ptyAttachment = null

  const attached = controlDeps.attachPhoneObserver(identity.paneId, {
    sinceCursor,
    role,
    sendData: (data) => {
      if (ws.readyState === ws.OPEN) ws.send(ptyOutputFrame(data))
    },
  })
  if (!attached) {
    ws.send(rpcError(msg.id, -32602, 'unknown pane (no live pty)'))
    return
  }
  state.ptyAttachment = {
    rendererPaneId: identity.paneId,
    canWrite: role === 'owner',
    detach: attached.detach,
  }
  ws.send(
    rpcResult(msg.id, {
      cursor: attached.cursor,
      dropped: attached.dropped,
      cols: attached.cols,
      rows: attached.rows,
      role,
    }),
  )
}

function handlePtyDetach(
  ws: WebSocket,
  state: SocketState,
  msg: { id?: unknown; params?: unknown },
): void {
  const p = (msg.params ?? {}) as { paneId?: unknown }
  if (state.ptyAttachment && typeof p.paneId === 'string') {
    const identity = resolveExternal(p.paneId)
    if (identity && identity.paneId !== state.ptyAttachment.rendererPaneId) {
      ws.send(rpcResult(msg.id, { ok: true }))
      return
    }
  }
  state.ptyAttachment?.detach()
  state.ptyAttachment = null
  ws.send(rpcResult(msg.id, { ok: true }))
}

function isPtyDim(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= MAX_PTY_DIM
}

function parseResize(payload: Buffer): { paneId?: unknown; cols: number; rows: number } | null {
  let resize: { paneId?: unknown; cols?: unknown; rows?: unknown }
  try {
    resize = JSON.parse(payload.toString('utf8'))
  } catch {
    return null
  }
  if (!resize || !isPtyDim(resize.cols) || !isPtyDim(resize.rows)) return null
  return { paneId: resize.paneId, cols: resize.cols, rows: resize.rows }
}

function resizeTargetsAttachment(paneId: unknown, attachment: PtyAttachment): boolean {
  if (paneId === undefined) return true
  if (typeof paneId !== 'string') return false
  return resolveExternal(paneId)?.paneId === attachment.rendererPaneId
}

function handleBinaryFrame(ws: WebSocket, state: SocketState, data: Buffer): void {
  if (!state.device || !controlDeps || data.length < 1) return
  const device = refreshDevice(state)
  if (!device) {
    ws.close(4003, 'revoked')
    return
  }
  const type = data[0]
  const payload = data.subarray(1)
  const attachment = state.ptyAttachment
  const canWrite = attachment?.canWrite === true && device.caps.includes('input')

  if (type === FRAME_PTY_INPUT || type === FRAME_PTY_RESIZE) {
    if (!attachment || !canWrite) {
      ws.send(rpcError(null, -32003, 'needs-elevation', { cap: 'input' }))
      return
    }
    if (type === FRAME_PTY_INPUT) {
      controlDeps.ptyWrite(attachment.rendererPaneId, payload.toString('utf8'))
      return
    }
    const resize = parseResize(payload)
    if (!resize || !resizeTargetsAttachment(resize.paneId, attachment)) return
    controlDeps.ptyResize(attachment.rendererPaneId, resize.cols, resize.rows)
  }
}

function handleConnection(ws: WebSocket): void {
  const state: SocketState = { device: null, alive: true, ptyAttachment: null }
  sockets.set(ws, state)
  const helloDeadline = setTimeout(() => {
    if (!state.device) ws.close(4001, 'hello timeout')
  }, HELLO_TIMEOUT_MS)

  ws.on('pong', () => {
    state.alive = true
  })

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      handleBinaryFrame(ws, state, data as Buffer)
      return
    }
    let msg: { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }
    try {
      msg = JSON.parse(data.toString('utf8'))
    } catch {
      ws.send(rpcError(null, -32700, 'parse error'))
      return
    }
    if (msg.method === 'hello') {
      handleHello(ws, state, msg)
      return
    }
    if (!state.device) {
      ws.send(rpcError(msg.id, -32001, 'unauthenticated'))
      ws.close(4001, 'unauthenticated')
      return
    }
    const device = refreshDevice(state)
    if (!device) {
      ws.send(rpcError(msg.id, -32001, 'device revoked'))
      ws.close(4003, 'revoked')
      return
    }
    if (msg.method === 'whoami') {
      handleWhoami(ws, device, msg)
      return
    }
    if (msg.method === 'device.caps') {
      handleDeviceCaps(ws, device, msg)
      return
    }
    if (msg.method === 'pty.attach') {
      handlePtyAttach(ws, state, device, msg)
      return
    }
    if (msg.method === 'pty.detach') {
      handlePtyDetach(ws, state, msg)
      return
    }
    handleControlMethod(ws, device, msg)
  })

  ws.on('close', () => {
    clearTimeout(helloDeadline)
    state.ptyAttachment?.detach()
    state.ptyAttachment = null
    if (state.device) untrackDeviceSocket(state.device.deviceId, ws)
    sockets.delete(ws)
  })
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
