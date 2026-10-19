import { PRODUCT_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/product'
import { app } from 'electron'
import type { WebSocket } from 'ws'
import { resolveExternal } from '../control/idRegistry'
import { type GatewayControlDeps, dispatchGatewayMethod } from './controlDispatch'
import { type Device, get as getDevice, verifyToken } from './devices'
import type { ScreenLinks } from './screenLinks'

const FRAME_PTY_OUTPUT = 0x01
const FRAME_PTY_INPUT = 0x02
const FRAME_PTY_RESIZE = 0x03
const MAX_PTY_DIM = 1000

const HELLO_TIMEOUT_MS = 10_000

const LINK_METHODS: ReadonlySet<unknown> = new Set(['ask.list', 'ask.answer'])

interface PtyAttachment {
  rendererPaneId: string
  canWrite: boolean
  detach: () => void
}

export interface PhoneSocketDeps {
  sockets: Map<WebSocket, SocketState>
  trackDeviceSocket: (deviceId: string, ws: WebSocket) => void
  untrackDeviceSocket: (deviceId: string, ws: WebSocket) => void
  controlDeps: () => GatewayControlDeps | null
  screenLinks: () => ScreenLinks | null
}

export interface SocketState {
  device: Device | null
  alive: boolean
  ptyAttachment: PtyAttachment | null
  attached: boolean
  screenTried: boolean
}

function refreshDevice(state: SocketState): Device | null {
  if (!state.device) return null
  const fresh = getDevice(state.device.deviceId)
  if (fresh) state.device = fresh
  return fresh
}

function rpcResult(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result })
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): string {
  const error: { code: number; message: string; data?: unknown } = { code, message }
  if (data !== undefined) error.data = data
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error })
}

function handleHello(
  ws: WebSocket,
  state: SocketState,
  msg: { id?: unknown; params?: unknown },
  trackDeviceSocket: PhoneSocketDeps['trackDeviceSocket'],
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

function handleScreenStart(
  ws: WebSocket,
  state: SocketState,
  device: Device,
  msg: { id?: unknown; params?: unknown },
  links: ScreenLinks | null,
): void {
  if (state.attached || state.screenTried) {
    ws.send(rpcError(msg.id, -32602, 'busy'))
    return
  }
  state.screenTried = true
  if (!links) {
    ws.send(rpcError(msg.id, -32004, 'no-controller'))
    return
  }
  links
    .start(ws, device, msg.params)
    .then((outcome) => {
      if (ws.readyState !== ws.OPEN) return
      if (outcome.ok) ws.send(rpcResult(msg.id, outcome.result))
      else ws.send(rpcError(msg.id, outcome.code, outcome.message, outcome.data))
    })
    .catch(() => ws.send(rpcError(msg.id, -32603, 'internal error')))
}

function handleScreenDecline(
  ws: WebSocket,
  device: Device,
  msg: { id?: unknown; params?: unknown },
  links: ScreenLinks | null,
): void {
  if (!device.caps.includes('notify')) {
    ws.send(rpcError(msg.id, -32003, 'needs-elevation', { cap: 'notify' }))
    return
  }
  const p = (msg.params ?? {}) as { requestId?: unknown; reason?: unknown }
  const reason =
    p.reason === 'off' || p.reason === 'unsupported' || p.reason === 'denied' ? p.reason : null
  if (typeof p.requestId !== 'string' || !reason) {
    ws.send(rpcError(msg.id, -32602, 'bad-params'))
    return
  }
  if (!links?.decline(p.requestId, device.deviceId, reason)) {
    ws.send(rpcError(msg.id, -32602, 'unknown-request'))
    return
  }
  ws.send(rpcResult(msg.id, {}))
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

function handleConnection(ws: WebSocket, deps: PhoneSocketDeps): void {
  const { sockets, trackDeviceSocket, untrackDeviceSocket } = deps
  const state: SocketState = {
    device: null,
    alive: true,
    ptyAttachment: null,
    attached: false,
    screenTried: false,
  }
  sockets.set(ws, state)
  const helloDeadline = setTimeout(() => {
    if (!state.device) ws.close(4001, 'hello timeout')
  }, HELLO_TIMEOUT_MS)

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
      handleHello(ws, state, msg, trackDeviceSocket)
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
    handleControlMethod(ws, device, msg, deps.controlDeps())
  })

  ws.on('close', (code) => {
    clearTimeout(helloDeadline)
    deps.screenLinks()?.closed(ws, code)
    state.ptyAttachment?.detach()
    state.ptyAttachment = null
    if (state.device) untrackDeviceSocket(state.device.deviceId, ws)
    sockets.delete(ws)
  })
}

export function createPhoneSocket(deps: PhoneSocketDeps) {
  return (ws: WebSocket): void => handleConnection(ws, deps)
}
