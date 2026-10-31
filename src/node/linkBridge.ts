import { once } from 'node:events'
import { createConnection } from 'node:net'
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node'
import { frameLine, LINK_FRAME_MAX } from '../shared/remote/linkFrames'

export async function runLinkBridge(socketPath: string): Promise<void> {
  const socket = createConnection(socketPath)
  await once(socket, 'connect')
  const conn = createMessageConnection(
    new StreamMessageReader(socket),
    new StreamMessageWriter(socket),
  )
  conn.onNotification('link.out', (line: string) => {
    process.stdout.write(`${line}\n`)
  })
  conn.onClose(() => process.exit(0))
  conn.listen()
  await conn.sendRequest('node.link')
  let pending = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    pending += chunk
    for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
      const line = pending.slice(0, end)
      pending = pending.slice(end + 1)
      if (line) void conn.sendNotification('link.in', line)
    }
    if (pending.length > LINK_FRAME_MAX) process.exit(1)
  })
  process.stdin.on('end', () => process.exit(0))
}

export function incompatibleLine(version: string): string {
  return frameLine({ t: 'incompatible', version })
}
