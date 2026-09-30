const { createConnection } = require('node:net')
const {
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
} = require('vscode-jsonrpc/node')

const socket = createConnection(process.env.PINE_SOCKET)
const conn = createMessageConnection(
  new StreamMessageReader(socket),
  new StreamMessageWriter(socket),
)

conn.onRequest('ext.command', async ({ command, args }) => {
  if (command === 'open') {
    try {
      return { ok: true, data: await conn.sendRequest('ext.openTerminal', args) }
    } catch (err) {
      return { ok: false, error: 'rpc', message: err.message }
    }
  }
  if (command === 'ask' || command === 'ask-plain') {
    const res = await conn.sendRequest('ext.confirm', { title: 'Wait', message: 'Answer me' })
    return { ok: false, error: 'answered', data: { confirmed: res.confirmed } }
  }
  return { ok: false, error: 'unknown' }
})

socket.on('close', () => process.exit(0))
conn.listen()

socket.on('connect', async () => {
  await conn.sendRequest('hello', { token: process.env.PINE_TOKEN })
  const commands = require('./pine.json').contributes.commands.map((c) => c.id)
  await conn.sendRequest('ext.registerCommands', { commands })
})
