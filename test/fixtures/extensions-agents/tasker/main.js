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

conn.onRequest('ext.command', async ({ command, args }) => {
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
  await conn.sendRequest('ext.registerCommands', { commands: ['call'] })
})
