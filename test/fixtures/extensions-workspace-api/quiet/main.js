const { createConnection } = require('node:net')
const {
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
} = require('vscode-jsonrpc/node')

const socket = createConnection(process.env.OSTIA_SOCKET)
const conn = createMessageConnection(
  new StreamMessageReader(socket),
  new StreamMessageWriter(socket),
)
const seen = []
const subscribes = process.env.OSTIA_EXTENSION_ID !== 'quiet'

conn.onNotification('ext.event', (event) => seen.push(event))
conn.onRequest('ext.command', async ({ command, args }) => {
  if (command === 'events') return { ok: true, data: seen }
  if (command !== 'call') return { ok: false, error: 'unknown' }
  try {
    return { ok: true, data: await conn.sendRequest(args.method, args.params) }
  } catch (err) {
    return { ok: false, error: 'rpc', message: err.message }
  }
})

socket.on('close', () => process.exit(0))
conn.listen()

socket.on('connect', async () => {
  await conn.sendRequest('hello', { token: process.env.OSTIA_TOKEN })
  if (subscribes) await conn.sendRequest('ext.subscribe', { events: ['workspace.closed'] })
  await conn.sendRequest('ext.registerCommands', { commands: ['call', 'events'] })
})
