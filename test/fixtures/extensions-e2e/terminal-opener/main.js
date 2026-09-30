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
  if (command !== 'run') return { ok: false, error: 'unknown' }
  const res = await conn.sendRequest('ext.openTerminal', {
    command: args.argv,
    afterPaneId: caller.paneId,
  })
  return { ok: true, data: res }
})

socket.on('close', () => process.exit(0))
conn.listen()
socket.on('connect', async () => {
  await conn.sendRequest('hello', { token: process.env.PINE_TOKEN })
  await conn.sendRequest('ext.registerCommands', { commands: ['run'] })
})
