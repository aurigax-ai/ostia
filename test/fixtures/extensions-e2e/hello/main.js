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

conn.onRequest('ext.command', async ({ command, args, caller }) => {
  if (command === 'open') return conn.sendRequest('ext.openPanel', { sessionId: caller.sessionId })
  if (command === 'greet') {
    const name = args?.argv?.[0]
    if (!name) return { ok: false, error: 'invalid-args', message: 'greet <name>' }
    await conn.sendRequest('ext.setSidebarItem', {
      sessionId: caller.sessionId,
      key: 'greeting',
      text: `hello ${name}`,
    })
    return { ok: true, text: `greeted ${name}` }
  }
  return { ok: false, error: 'unknown' }
})

socket.on('close', () => process.exit(0))
conn.listen()

socket.on('connect', async () => {
  await conn.sendRequest('hello', { token: process.env.PINE_TOKEN })
  await conn.sendRequest('ext.registerCommands', { commands: ['open', 'greet'] })
})
