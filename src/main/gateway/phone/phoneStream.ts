import type { WebSocket } from 'ws'
import {
  STREAM_TURNS_DEFAULT,
  STREAM_TURNS_MAX,
  type StreamEnd,
  type StreamEvent,
} from '../../../shared/agents/agentStream'
import type { PreparedStream } from '../../agents/agentStreams'
import type { GatewayControlDeps } from '../controlDispatch'
import type { Device } from '../devices'
import type { SocketState } from '../phoneSocket'
import { rpcError, rpcResult } from '../rpcFrames'
import { FrameTooLarge, packFrames } from '../streamFrames'
import { turnPane } from './phoneTurns'

export const STREAMS_PER_SOCKET = 4
export const STREAM_BUFFER_MAX = 8 * 1024 * 1024
export const SCOPE_CHECK_MS = 3000

type Message = { id?: unknown; params?: unknown }

const RESERVED = { agent: 'claude', session: null, truncated: false } as const

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

function reservation(): PreparedStream {
  return { ...RESERVED, start: () => undefined, close: () => undefined }
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
  const key = typeof params.paneId === 'string' ? params.paneId : ''
  if (key && !state.streams.has(key) && state.streams.size >= STREAMS_PER_SOCKET) {
    ws.send(rpcError(msg.id, -32602, 'too-many-streams'))
    return
  }
  const mine = reservation()
  if (key) {
    state.streams.get(key)?.close()
    state.streams.set(key, mine)
  }
  const release = (): void => {
    if (state.streams.get(key) === mine) state.streams.delete(key)
  }
  try {
    const found = await turnPane({ paneId: params.paneId }, controlDeps)
    if ('ok' in found) {
      release()
      if (!found.ok) ws.send(rpcError(msg.id, found.code, found.message))
      return
    }
    const paneId = found.pane.externalId
    const prepared = await controlDeps.agentStreams.open(found.pane, turns)
    if ('error' in prepared) {
      release()
      const refused = prepared.error === 'not-an-agent'
      ws.send(rpcError(msg.id, refused ? -32602 : -32603, prepared.error))
      return
    }
    if (ws.readyState !== ws.OPEN || state.streams.get(key) !== mine) {
      prepared.close()
      release()
      return
    }
    let watch: ReturnType<typeof setInterval> | null = null
    let ended = false
    const stream: PreparedStream = {
      ...prepared,
      close: () => {
        if (watch) clearInterval(watch)
        watch = null
        prepared.close()
      },
    }
    state.streams.set(key, stream)
    const finish = (reason: StreamEnd): void => {
      if (ended) return
      ended = true
      if (ws.readyState === ws.OPEN) {
        for (const frame of packFrames(
          paneId,
          seq,
          false,
          [{ type: 'ended', reason }],
          maxFrameBytes,
        )) {
          ws.send(frame)
        }
      }
      stream.close()
      if (state.streams.get(key) === stream) state.streams.delete(key)
    }
    let seq = 1
    const deliver = (events: StreamEvent[], backfill: boolean): void => {
      if (ended || ws.readyState !== ws.OPEN) return
      if (ws.bufferedAmount > STREAM_BUFFER_MAX) {
        finish('too-slow')
        return
      }
      try {
        for (const frame of packFrames(paneId, seq, backfill, events, maxFrameBytes)) {
          ws.send(frame)
          seq += 1
        }
      } catch (err) {
        if (!(err instanceof FrameTooLarge)) throw err
        finish('too-large')
      }
    }
    ws.send(
      rpcResult(msg.id, {
        ok: true,
        paneId,
        agent: prepared.agent,
        session: prepared.session,
        truncated: prepared.truncated,
      }),
    )
    prepared.start((events, backfill) => deliver(events, backfill))
    watch = setInterval(async () => {
      const again = await turnPane({ paneId: key }, controlDeps).catch(() => null)
      if (again === null || 'ok' in again) finish('out-of-scope')
    }, SCOPE_CHECK_MS)
  } catch (err) {
    release()
    throw err
  }
}

export function handleStreamClose(ws: WebSocket, state: SocketState, msg: Message): void {
  const { paneId } = (msg.params ?? {}) as { paneId?: unknown }
  if (typeof paneId === 'string') {
    state.streams.get(paneId)?.close()
    state.streams.delete(paneId)
  }
  ws.send(rpcResult(msg.id, { ok: true }))
}
