import type { WebSocket } from 'ws'
import type { Device } from '../devices'
import type { SocketState } from '../phoneSocket'
import { rpcError, rpcResult } from '../rpcFrames'
import type { ScreenLinks } from '../screenLinks'

export function handleScreenStart(
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

export function handleScreenDecline(
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
