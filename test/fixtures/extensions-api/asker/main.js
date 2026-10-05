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
  if (command === 'confirm') return { ok: true, data: await conn.sendRequest('ext.confirm', args) }
  if (command === 'notify-panel') {
    return conn.sendRequest('ext.notify', { title: 'look', body: 'here', openPanel: true })
  }
  return { ok: false, error: 'unknown' }
})

conn.onRequest('ext.panel', () => ({ url: 'http://127.0.0.1:9/' }))

socket.on('close', () => process.exit(0))
conn.listen()

socket.on('connect', async () => {
  await conn.sendRequest('hello', { token: process.env.OSTIA_TOKEN })
  await conn.sendRequest('ext.registerCommands', { commands: ['confirm', 'notify-panel'] })
})
