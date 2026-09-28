const { createConnection } = require('node:net')
const {
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
} = require('vscode-jsonrpc/node')

const socket = createConnection(process.env.PINE_SOCKET)
const conn = createMessageConnection(new StreamMessageReader(socket), new StreamMessageWriter(socket))

conn.onRequest('ext.command', async ({ command, args, caller }) => {
  if (command === 'echo') return { ok: true, text: 'echoed', data: { args, caller, pid: process.pid } }
  if (command === 'guarded') return { ok: true, text: 'guarded ran' }
  if (command === 'probe') {
    try {
      await conn.sendRequest('command.list')
      return { ok: true, text: 'allowed' }
    } catch (err) {
      return { ok: false, error: 'rejected', message: err.message }
    }
  }
  if (command === 'notify') return conn.sendRequest('ext.notify', { title: 'from echo', body: 'hi' })
  if (command === 'diff') return conn.sendRequest('ext.openDiff', args)
  if (command === 'sessions') {
    return { ok: true, data: await conn.sendRequest('session.list') }
  }
  if (command === 'crash') process.exit(3)
  return { ok: false, error: 'unknown' }
})

conn.onRequest('ext.panel', ({ caller }) => ({
  url: `http://127.0.0.1:9/?session=${encodeURIComponent(caller.sessionId || '')}`,
}))

conn.onNotification('ext.event', ({ type, payload }) => {
  void conn.sendRequest('ext.setSidebarItem', { key: type, text: `${type}:${payload.paneId}` })
})

socket.on('close', () => process.exit(0))
conn.listen()

socket.on('connect', async () => {
  await conn.sendRequest('hello', { token: process.env.PINE_TOKEN })
  await conn.sendRequest('ext.subscribe', { events: ['pane.created'] })
  await conn.sendRequest('ext.registerCommands', {
    commands: ['echo', 'guarded', 'probe', 'notify', 'diff', 'sessions', 'crash'],
  })
})
