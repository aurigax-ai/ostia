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
  if (command === 'echo')
    return { ok: true, text: 'echoed', data: { args, caller, pid: process.pid } }
  if (command === 'guarded') return { ok: true, text: 'guarded ran' }
  if (command === 'api') return { ok: true, text: process.env.PINE_EXTENSION_API }
  if (command === 'probe') {
    try {
      await conn.sendRequest('command.list')
      return { ok: true, text: 'allowed' }
    } catch (err) {
      return { ok: false, error: 'rejected', message: err.message }
    }
  }
  if (command === 'notify')
    return conn.sendRequest('ext.notify', { title: 'from echo', body: 'hi' })
  if (command === 'diff') return conn.sendRequest('ext.openDiff', args)
  if (command === 'workspaces') {
    return { ok: true, data: await conn.sendRequest('workspace.list') }
  }
  if (command === 'crash') process.exit(3)
  if (command === 'stdin') return { ok: true, text: `stdin:${args.stdin}` }
  if (command === 'chip') return conn.sendRequest('ext.setPaneChip', args)
  if (command === 'unchip') return conn.sendRequest('ext.clearPaneChip', args)
  if (command === 'settings') return { ok: true, data: await conn.sendRequest('ext.getSettings') }
  if (command === 'seen-settings') return { ok: true, data: seenSettings }
  if (command === 'open-panel') return conn.sendRequest('ext.openPanel', args)
  if (command === 'notify-panel') {
    return conn.sendRequest('ext.notify', { title: 'look', openPanel: args.openPanel })
  }
  if (command === 'call') {
    try {
      return { ok: true, data: await conn.sendRequest(args.method, args.params) }
    } catch (err) {
      return { ok: false, error: 'rejected', message: err.message }
    }
  }
  return { ok: false, error: 'unknown' }
})

let seenSettings = null

conn.onRequest('ext.panel', ({ caller, path }) => ({
  url: `http://127.0.0.1:9${path || '/'}?workspace=${encodeURIComponent(caller.workspaceId || '')}`,
}))

conn.onNotification('ext.event', ({ type, payload }) => {
  if (type === 'settings.changed') {
    seenSettings = payload.values
    return
  }
  void conn.sendRequest('ext.setSidebarItem', { key: type, text: `${type}:${payload.paneId}` })
})

socket.on('close', () => process.exit(0))
conn.listen()

socket.on('connect', async () => {
  await conn.sendRequest('hello', { token: process.env.PINE_TOKEN })
  await conn.sendRequest('ext.subscribe', { events: ['pane.created'] })
  await conn.sendRequest('ext.registerCommands', {
    commands: [
      'echo',
      'guarded',
      'probe',
      'api',
      'notify',
      'diff',
      'workspaces',
      'crash',
      'stdin',
      'chip',
      'unchip',
      'settings',
      'seen-settings',
      'open-panel',
      'notify-panel',
      'call',
    ],
  })
})
