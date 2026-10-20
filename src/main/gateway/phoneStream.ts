import type { WebSocket } from 'ws'
import { STREAM_TURNS_DEFAULT, STREAM_TURNS_MAX } from '../../shared/agents/agentStream'
import type { GatewayControlDeps } from './controlDispatch'
import type { Device } from './devices'
import type { SocketState } from './phoneSocket'
import { turnPane } from './phoneTurns'
import { rpcError, rpcResult } from './rpcFrames'
import { packFrames } from './streamFrames'

export const STREAMS_PER_SOCKET = 4

type Message = { id?: unknown; params?: unknown }

function turnsOf(raw: unknown): number | null {
  if (raw === undefined) return STREAM_TURNS_DEFAULT
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= STREAM_TURNS_MAX
    ? raw
    : null
}

export function closeStreams(state: Pick<SocketState, 'streams'>): void {
  for (const stream of state.streams.values()) stream.close()
  state.streams.clear()
}

export function handleStreamOpen(
  ws: WebSocket,
  state: SocketState,
  device: Device,
  msg: Message,
  controlDeps: GatewayControlDeps | null,
  maxFrameBytes: number,
): void {
  open(ws, state, device, msg, controlDeps, maxFrameBytes).catch((err) => {
    ws.send(rpcError(msg.id, -32603, err instanceof Error ? err.message : 'internal error'))
  })
}

async function open(
  ws: WebSocket,
  state: SocketState,
  device: Device,
  msg: Message,
  controlDeps: GatewayControlDeps | null,
  maxFrameBytes: number,
): Promise<void> {
  if (!controlDeps) {
    ws.send(rpcError(msg.id, -32603, 'gateway control API not configured'))
    return
  }
  if (!device.caps.includes('read')) {
    ws.send(rpcError(msg.id, -32003, 'needs-elevation', { cap: 'read' }))
    return
  }
  const params = (msg.params ?? {}) as { paneId?: unknown; turns?: unknown }
  const turns = turnsOf(params.turns)
  if (turns === null) {
    ws.send(rpcError(msg.id, -32602, 'bad-params'))
    return
  }
  const found = await turnPane({ paneId: params.paneId }, controlDeps)
  if ('ok' in found) {
    if (!found.ok) ws.send(rpcError(msg.id, found.code, found.message))
    return
  }
  const paneId = found.pane.externalId
  if (!state.streams.has(paneId) && state.streams.size >= STREAMS_PER_SOCKET) {
    ws.send(rpcError(msg.id, -32602, 'too-many-streams'))
    return
  }
  state.streams.get(paneId)?.close()
  state.streams.delete(paneId)
  const prepared = await controlDeps.agentStreams.open(found.pane, turns)
  if ('error' in prepared) {
    const refused = prepared.error === 'not-an-agent'
    ws.send(rpcError(msg.id, refused ? -32602 : -32603, prepared.error))
    return
  }
  if (ws.readyState !== ws.OPEN) {
    prepared.close()
    return
  }
  state.streams.get(paneId)?.close()
  state.streams.set(paneId, prepared)
  ws.send(
    rpcResult(msg.id, {
      ok: true,
      paneId,
      agent: prepared.agent,
      session: prepared.session,
      truncated: prepared.truncated,
    }),
  )
  let seq = 1
  prepared.start((events, backfill) => {
    if (ws.readyState !== ws.OPEN) return
    for (const frame of packFrames(paneId, seq, backfill, events, maxFrameBytes)) {
      ws.send(frame)
      seq += 1
    }
  })
}

export function handleStreamClose(ws: WebSocket, state: SocketState, msg: Message): void {
  const { paneId } = (msg.params ?? {}) as { paneId?: unknown }
  if (typeof paneId === 'string') {
    state.streams.get(paneId)?.close()
    state.streams.delete(paneId)
  }
  ws.send(rpcResult(msg.id, { ok: true }))
}
