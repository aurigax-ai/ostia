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
  if (command === 'open') return conn.sendRequest('ext.openPanel', { workspaceId: caller.workspaceId })
  if (command === 'greet') {
    const name = args?.argv?.[0]
    if (!name) return { ok: false, error: 'invalid-args', message: 'greet <name>' }
    const { values } = await conn.sendRequest('ext.getSettings')
    await conn.sendRequest('ext.setSidebarItem', {
      workspaceId: caller.workspaceId,
      key: 'greeting',
      text: `${values.greeting} ${name}`,
    })
    return { ok: true, text: `greeted ${name}` }
  }
  if (command === 'chip') {
    return conn.sendRequest('ext.setPaneChip', {
      paneId: caller.paneId,
      id: 'greeting',
      text: 'hello chip',
      tone: 'ok',
      command: 'open',
    })
  }
  if (command === 'card') {
    return conn.sendRequest('ext.openPanel', { workspaceId: caller.workspaceId, path: '/card.html' })
  }
  return { ok: false, error: 'unknown' }
})

socket.on('close', () => process.exit(0))
conn.listen()

socket.on('connect', async () => {
  await conn.sendRequest('hello', { token: process.env.PINE_TOKEN })
  await conn.sendRequest('ext.registerCommands', { commands: ['open', 'greet', 'chip', 'card'] })
})
