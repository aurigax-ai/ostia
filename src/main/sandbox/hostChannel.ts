import { chmodSync, lstatSync, rmSync } from 'node:fs'
import { type Socket, connect, createServer } from 'node:net'
import type { HostAsk, HostResponse, HostToMain, MainToHost } from './protocol'

const NEWLINE = 0x0a
const QUEUE_MAX = 200
const MESSAGE_MAX_BYTES = 8 * 1024 * 1024

export class HostChannelError extends Error {}

export class JsonLines {
  private pending = Buffer.alloc(0)

  constructor(private readonly onMessage: (message: unknown) => void) {}

  push(chunk: Buffer): void {
    let data = this.pending.length > 0 ? Buffer.concat([this.pending, chunk]) : chunk
    let newline = data.indexOf(NEWLINE)
    while (newline !== -1) {
      const line = data.subarray(0, newline).toString('utf8')
      data = data.subarray(newline + 1)
      newline = data.indexOf(NEWLINE)
      try {
        this.onMessage(JSON.parse(line))
      } catch {}
    }
    if (data.length > MESSAGE_MAX_BYTES) data = Buffer.alloc(0)
    this.pending = Buffer.from(data)
  }
}

export function writeMessage(socket: Socket, message: unknown): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`)
}

export function checkHostChannel(path: string, uid: number): void {
  let st: ReturnType<typeof lstatSync>
  try {
    st = lstatSync(path)
  } catch {
    throw new HostChannelError(`no sandbox host is listening at ${path}`)
  }
  if (!st.isSocket() || st.uid !== uid) {
    throw new HostChannelError(`refusing ${path}: not a socket owned by uid ${uid}`)
  }
}

export async function connectHostChannel(
  path: string,
  uid: number = process.getuid?.() ?? 0,
): Promise<Socket> {
  checkHostChannel(path, uid)
  return await new Promise((resolve, reject) => {
    const socket = connect(path)
    socket.once('connect', () => {
      socket.removeListener('error', reject)
      resolve(socket)
    })
    socket.once('error', reject)
  })
}

export type Respond = (response: HostResponse) => void

export interface ListeningChannel {
  send(message: HostToMain): void
  close(): void
}

function isAsk(message: HostToMain): message is HostAsk {
  return 'type' in message && message.type === 'ask'
}

export function listenHostChannel(
  path: string,
  onMessage: (message: MainToHost, respond: Respond) => void,
): Promise<ListeningChannel> {
  let current: Socket | null = null
  const queue: HostToMain[] = []
  const asks = new Map<number, HostAsk>()

  const server = createServer((socket) => {
    current?.destroy()
    current = socket
    const lines = new JsonLines((raw) => {
      const message = raw as MainToHost
      if (message.type === 'ask-answer') asks.delete(message.askId)
      onMessage(message, (response) => writeMessage(socket, response))
    })
    socket.on('data', (chunk: Buffer) => lines.push(chunk))
    socket.on('error', () => socket.destroy())
    socket.on('close', () => {
      if (current === socket) current = null
    })
    for (const message of queue.splice(0)) writeMessage(socket, message)
    for (const ask of asks.values()) writeMessage(socket, ask)
  })

  rmSync(path, { force: true })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => {
      chmodSync(path, 0o600)
      resolve({
        send: (message) => {
          if (isAsk(message)) asks.set(message.askId, message)
          if (current) writeMessage(current, message)
          else if (!isAsk(message) && !('id' in message) && queue.length < QUEUE_MAX) {
            queue.push(message)
          }
        },
        close: () => {
          current?.destroy()
          server.close()
          rmSync(path, { force: true })
        },
      })
    })
  })
}
