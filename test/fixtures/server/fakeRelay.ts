import { randomBytes } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { type WebSocket, WebSocketServer } from 'ws'
import type { FakeDevice, FakeServer } from './fakeServer'

interface Listener {
  ws: WebSocket
  deviceId: string
}

export interface PhoneStream {
  id: string
  received: () => Buffer
  send: (data: Buffer) => void
  onData: (listener: (data: Buffer) => void) => void
  accepted: Promise<void>
  closed: Promise<void>
  close: () => void
}

interface PendingStream {
  id: string
  deviceId: string
  ws: WebSocket | null
  chunks: Buffer[]
  listeners: Array<(data: Buffer) => void>
  confirmed: boolean
  accept: () => void
  closed: () => void
}

export class FakeRelay {
  private readonly sockets = new WebSocketServer({ noServer: true })
  private readonly listeners = new Map<string, Listener>()
  private readonly streams = new Map<string, PendingStream>()

  constructor(private readonly server: FakeServer) {}

  terminateAll(): void {
    for (const client of this.sockets.clients) client.terminate()
  }

  listenerCount(): number {
    return this.listeners.size
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

  pingListeners(): void {
    for (const { ws } of this.listeners.values()) ws.send('{"t":"ping"}')
  }

  phoneConnect(peer: string, family: 4 | 6 = 4): PhoneStream {
    const listener = [...this.listeners.values()][0]
    if (!listener) throw new Error('no desktop is listening')
    const id = randomBytes(9).toString('base64url')
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
      listeners: [],
      confirmed: false,
      accept,
      closed,
    }
    this.streams.set(id, stream)
    listener.ws.send(JSON.stringify({ t: 'incoming', stream: id, peer, family }))
    return {
      id,
      received: () => Buffer.concat(stream.chunks),
      send: (data) => stream.ws?.send(data, { binary: true }),
      onData: (listener) => stream.listeners.push(listener),
      accepted,
      closed: closedPromise,
      close: () => stream.ws?.close(),
    }
  }

  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const auth = this.server.sessionOf(req)
    const path = req.url ?? ''
    this.server.requests.push(`UPGRADE ${path}`)
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
    this.server.listenerConnections += 1
    this.listeners.get(deviceId)?.ws.close(1008)
    const listener = { ws, deviceId }
    this.listeners.set(deviceId, listener)
    const viewer = this.server.devices.get(deviceId)
    if (viewer) {
      for (const peer of this.server.accountDevices(viewer.accountId)) {
        if (this.server.isUnseen(viewer, peer)) this.notifyAdded(deviceId, peer)
      }
    }
    ws.on('message', (data) => {
      const message = JSON.parse(data.toString('utf8')) as { t?: string; stream?: string }
      if (message.t === 'pong') this.server.pongs += 1
      if (message.t === 'confirm' && message.stream) {
        this.server.confirmed.push(message.stream)
        const stream = this.streams.get(message.stream)
        if (stream) stream.confirmed = true
      }
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
    ws.on('message', (data: Buffer) => {
      stream.chunks.push(Buffer.from(data))
      for (const listener of stream.listeners) listener(Buffer.from(data))
    })
    const limit = this.server.options.unconfirmedMs
    const timer = limit
      ? setTimeout(() => {
          if (!stream.confirmed) ws.close(1008)
        }, limit)
      : null
    ws.on('close', () => {
      if (timer) clearTimeout(timer)
      stream.closed()
    })
    stream.accept()
  }

  notifyAdded(listenerId: string, device: FakeDevice): void {
    this.listeners.get(listenerId)?.ws.send(
      JSON.stringify({
        t: 'device-added',
        deviceId: device.id,
        name: device.name,
        createdAt: device.createdAt,
      }),
    )
  }
}
