import { PRODUCT_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/product'
import { app } from 'electron'
import type { WebSocket } from 'ws'
import type { PreparedStream } from '../agents/agentStreams'
import { resolveExternal } from '../control/idRegistry'
import type { PhoneObserver } from '../terminal/pty/ptyIo'
import type { GatewayAddress } from './addresses'
import { dispatchGatewayMethod, type GatewayControlDeps } from './controlDispatch'
import { type Device, get as getDevice, setDeviceName, verifyToken } from './devices'
import { PHONE_IMAGE_FRAME_BYTES } from './phone/phoneImage'
import { handleScreenDecline, handleScreenStart } from './phone/phoneScreenHandlers'
import { closeStreams, handleStreamClose, handleStreamOpen } from './phone/phoneStream'
import { rpcError, rpcResult } from './rpcFrames'
import type { ScreenLinks } from './screenLinks'

const FRAME_PTY_OUTPUT = 0x01
const FRAME_PTY_INPUT = 0x02
const FRAME_PTY_RESIZE = 0x03

const HELLO_TIMEOUT_MS = 10_000

export const PHONE_FRAME_BYTES = 1024 * 1024

interface WithReceiver {
  _receiver: { _maxPayload: number }
}

function allowImageFrames(ws: WebSocket): void {
  ;(ws as unknown as WithReceiver)._receiver._maxPayload = PHONE_IMAGE_FRAME_BYTES
}

const LINK_METHODS: ReadonlySet<unknown> = new Set(['ask.list', 'ask.answer'])

interface PtyAttachment {
  rendererPaneId: string
  canWrite: boolean
  hold: PhoneObserver['hold']
  release: PhoneObserver['release']
  detach: () => void
}

export interface PhoneSocketDeps {
  sockets: Map<WebSocket, SocketState>
  trackDeviceSocket: (deviceId: string, ws: WebSocket) => void
  untrackDeviceSocket: (deviceId: string, ws: WebSocket) => void
  controlDeps: () => GatewayControlDeps | null
  screenLinks: () => ScreenLinks | null
  addresses: () => GatewayAddress[]
  accepted: (socket: object) => void
}

export interface SocketState {
  device: Device | null
  alive: boolean
  ptyAttachment: PtyAttachment | null
  streams: Map<string, PreparedStream>
  attached: boolean
  screenTried: boolean
}

function refreshDevice(state: SocketState): Device | null {
  if (!state.device) return null
  const fresh = getDevice(state.device.deviceId)
  if (fresh) state.device = fresh
  return fresh
}

function handleHello(
  ws: WebSocket,
  state: SocketState,
  msg: { id?: unknown; params?: unknown },
  trackDeviceSocket: PhoneSocketDeps['trackDeviceSocket'],
  controlDeps: GatewayControlDeps | null,
  addresses: GatewayAddress[],
  accepted: () => void,
): void {
  const params = (msg.params ?? {}) as { deviceToken?: unknown; name?: unknown }
  const device = typeof params.deviceToken === 'string' ? verifyToken(params.deviceToken) : null
  if (!device) {
    ws.send(rpcError(msg.id, -32001, 'unauthenticated'))
    ws.close(4001, 'unauthenticated')
    return
  }
  if (params.name !== undefined) setDeviceName(device.deviceId, params.name)
  state.device = device
  accepted()
  const takesImages = device.caps.includes('respond')
  if (takesImages) allowImageFrames(ws)
  trackDeviceSocket(device.deviceId, ws)
  const phoneWorkspace = controlDeps?.phoneDefaults() ?? { set: false, agent: 'claude' }
  const push = controlDeps?.push.hello(device)
  ws.send(
    rpcResult(msg.id, {
      deviceId: device.deviceId,
      caps: device.caps,
      desktop: { name: PRODUCT_NAME, version: app.getVersion() },
      phoneWorkspace,
      addresses,
      features: takesImages ? ['prompt-image'] : [],
      ...(push ? { push } : {}),
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
  controlDeps: GatewayControlDeps | null,
): void {
  if (!controlDeps) {
    ws.send(rpcError(msg.id, -32603, 'gateway control API not configured'))
    return
  }
  dispatchGatewayMethod(String(msg.method), msg.params, device.caps, controlDeps, device.deviceId)
    .then((outcome) => {
      if (outcome.ok) ws.send(rpcResult(msg.id, outcome.result))
      else ws.send(rpcError(msg.id, outcome.code, outcome.message, outcome.data))
    })
    .catch((err) => {
      ws.send(rpcError(msg.id, -32603, err instanceof Error ? err.message : 'internal error'))
    })
}

function handleLinkMessage(
  ws: WebSocket,
  device: Device,
  msg: { id?: unknown; method?: unknown; params?: unknown },
  links: ScreenLinks,
  controlDeps: GatewayControlDeps | null,
): void {
  if (links.fromPhone(ws, msg)) return
  if (LINK_METHODS.has(msg.method)) {
    handleControlMethod(ws, device, msg, controlDeps)
    return
  }
  ws.send(rpcError(msg.id, -32600, 'link-only'))
}

function ptyOutputFrame(data: string): Buffer {
  return Buffer.concat([Buffer.from([FRAME_PTY_OUTPUT]), Buffer.from(data, 'utf8')])
}

function ptySizeFrame(paneId: string, cols: number, rows: number): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    method: 'event',
    params: { type: 'pty.size', payload: { paneId, cols, rows } },
  })
}

function handlePtyAttach(
  ws: WebSocket,
  state: SocketState,
  device: Device,
  msg: { id?: unknown; params?: unknown },
  controlDeps: GatewayControlDeps | null,
): void {
  if (!controlDeps) {
    ws.send(rpcError(msg.id, -32603, 'gateway control API not configured'))
    return
  }
  if (state.screenTried) {
    ws.send(rpcError(msg.id, -32600, 'link-only'))
    return
  }
  state.attached = true
  if (!device.caps.includes('read')) {
    ws.send(rpcError(msg.id, -32003, 'needs-elevation', { cap: 'read' }))
    return
  }
  const p = (msg.params ?? {}) as { paneId?: unknown; role?: unknown; sinceCursor?: unknown }
  if (typeof p.paneId !== 'string' || !p.paneId) {
    ws.send(rpcError(msg.id, -32602, 'missing paneId'))
    return
  }
  const externalPaneId = p.paneId
  const identity = resolveExternal(externalPaneId)
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
    sendSize: (cols, rows) => {
      if (ws.readyState === ws.OPEN) ws.send(ptySizeFrame(externalPaneId, cols, rows))
    },
  })
  if (!attached) {
    ws.send(rpcError(msg.id, -32602, 'unknown pane (no live pty)'))
    return
  }
  state.ptyAttachment = {
    rendererPaneId: identity.paneId,
    canWrite: role === 'owner',
    hold: attached.hold,
    release: attached.release,
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

const MAX_PTY_DIM = 1000

function isPtyDim(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= MAX_PTY_DIM
}

function heldAttachment(
  ws: WebSocket,
  state: SocketState,
  device: Device,
  msg: { id?: unknown; params?: unknown },
): PtyAttachment | null {
  if (!device.caps.includes('input')) {
    ws.send(rpcError(msg.id, -32003, 'needs-elevation', { cap: 'input' }))
    return null
  }
  const p = (msg.params ?? {}) as { paneId?: unknown }
  const identity = typeof p.paneId === 'string' ? resolveExternal(p.paneId) : undefined
  const attachment = state.ptyAttachment
  if (!attachment || identity?.paneId !== attachment.rendererPaneId) {
    ws.send(rpcError(msg.id, -32602, 'not-attached'))
    return null
  }
  if (!attachment.canWrite) {
    ws.send(rpcError(msg.id, -32602, 'not-owner'))
    return null
  }
  return attachment
}

function handlePtyHold(
  ws: WebSocket,
  state: SocketState,
  device: Device,
  msg: { id?: unknown; params?: unknown },
): void {
  const attachment = heldAttachment(ws, state, device, msg)
  if (!attachment) return
  const { cols, rows } = (msg.params ?? {}) as { cols?: unknown; rows?: unknown }
  if (!isPtyDim(cols) || !isPtyDim(rows)) {
    ws.send(rpcError(msg.id, -32602, 'bad-size'))
    return
  }
  if (attachment.hold(cols, rows) === 'held-by-other') {
    ws.send(rpcError(msg.id, -32602, 'held-by-other'))
    return
  }
  ws.send(rpcResult(msg.id, { ok: true, cols, rows }))
}

function handlePtyRelease(
  ws: WebSocket,
  state: SocketState,
  device: Device,
  msg: { id?: unknown; params?: unknown },
): void {
  const attachment = heldAttachment(ws, state, device, msg)
  if (!attachment) return
  attachment.release()
  ws.send(rpcResult(msg.id, { ok: true }))
}

function handleBinaryFrame(
  ws: WebSocket,
  state: SocketState,
  data: Buffer,
  controlDeps: GatewayControlDeps | null,
  links: ScreenLinks | null,
): void {
  if (!state.device || !controlDeps || data.length < 1) return
  const device = refreshDevice(state)
  if (!device) {
    ws.close(4003, 'revoked')
    return
  }
  if (links?.isLink(ws)) {
    links.frame(ws, data)
    return
  }
  const type = data[0]
  const payload = data.subarray(1)
  const attachment = state.ptyAttachment
  const canWrite = attachment?.canWrite === true && device.caps.includes('input')

  if (type === FRAME_PTY_RESIZE) {
    ws.send(rpcError(null, -32602, 'resize-not-supported'))
    return
  }
  if (type === FRAME_PTY_INPUT) {
    if (!attachment || !canWrite) {
      ws.send(rpcError(null, -32003, 'needs-elevation', { cap: 'input' }))
      return
    }
    controlDeps.ptyWrite(attachment.rendererPaneId, payload.toString('utf8'), 'key')
  }
}

function handleConnection(ws: WebSocket, peerSocket: object, deps: PhoneSocketDeps): void {
  const { sockets, trackDeviceSocket, untrackDeviceSocket } = deps
  const state: SocketState = {
    device: null,
    alive: true,
    ptyAttachment: null,
    streams: new Map(),
    attached: false,
    screenTried: false,
  }
  sockets.set(ws, state)
  const helloDeadline = setTimeout(() => {
    if (!state.device) ws.close(4001, 'hello timeout')
  }, HELLO_TIMEOUT_MS)

  ws.on('error', () => {
    if (ws.readyState !== ws.CLOSING) ws.terminate()
  })

  ws.on('pong', () => {
    state.alive = true
  })

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      handleBinaryFrame(ws, state, data as Buffer, deps.controlDeps(), deps.screenLinks())
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
      handleHello(ws, state, msg, trackDeviceSocket, deps.controlDeps(), deps.addresses(), () =>
        deps.accepted(peerSocket),
      )
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
    const links = deps.screenLinks()
    if (links?.isLink(ws)) {
      handleLinkMessage(ws, device, msg, links, deps.controlDeps())
      return
    }
    if (msg.method === 'screen.start') {
      handleScreenStart(ws, state, device, msg, links)
      return
    }
    if (msg.method === 'screen.decline') {
      handleScreenDecline(ws, device, msg, links)
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
      handlePtyAttach(ws, state, device, msg, deps.controlDeps())
      return
    }
    if (msg.method === 'pty.detach') {
      handlePtyDetach(ws, state, msg)
      return
    }
    if (msg.method === 'agent.stream.open') {
      handleStreamOpen(ws, state, device, msg, deps.controlDeps(), PHONE_FRAME_BYTES)
      return
    }
    if (msg.method === 'agent.stream.close') {
      handleStreamClose(ws, state, msg)
      return
    }
    if (msg.method === 'pty.hold') {
      handlePtyHold(ws, state, device, msg)
      return
    }
    if (msg.method === 'pty.release') {
      handlePtyRelease(ws, state, device, msg)
      return
    }
    handleControlMethod(ws, device, msg, deps.controlDeps())
  })

  ws.on('close', (code) => {
    clearTimeout(helloDeadline)
    deps.screenLinks()?.closed(ws, code)
    state.ptyAttachment?.detach()
    state.ptyAttachment = null
    closeStreams(state)
    if (state.device) untrackDeviceSocket(state.device.deviceId, ws)
    sockets.delete(ws)
  })
}

export function createPhoneSocket(deps: PhoneSocketDeps) {
  return (ws: WebSocket, peerSocket: object): void => handleConnection(ws, peerSocket, deps)
}
