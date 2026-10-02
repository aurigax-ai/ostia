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

let settingsEvents = 0

conn.onRequest('ext.command', async ({ command, args }) => {
  if (command === 'secret')
    return { ok: true, data: await conn.sendRequest('ext.getSecret', { key: 'apiKey' }) }
  if (command === 'events') return { ok: true, data: settingsEvents }
  if (command === 'status') return conn.sendRequest('ext.setAssistStatus', { status: args })
  if (command === 'shortcuts')
    return { ok: true, data: await conn.sendRequest('ext.shortcuts', { ids: args }) }
  if (command === 'openui') return conn.sendRequest('ext.openAssistUi', args)
  return { ok: false, error: 'unknown-command' }
})

conn.onNotification('ext.event', ({ type }) => {
  if (type === 'settings.changed') settingsEvents += 1
})

function untilCancelled(token) {
  return new Promise((resolve) => {
    if (token.isCancellationRequested) resolve()
    else token.onCancellationRequested(() => resolve())
  })
}

conn.onRequest('ext.assist', async ({ point, requestId, input }, token) => {
  if (point === 'chat') {
    const last = input.messages[input.messages.length - 1].content
    if (last === 'hang') {
      await untilCancelled(token)
      return { error: 'cancelled' }
    }
    const parts = ['Use ', '`ls -la`', ` (${input.context.length} context)`]
    const live = []
    for (const text of parts) {
      const res = await conn.sendRequest('ext.assistChunk', { requestId, text })
      live.push(res.live)
    }
    return { text: parts.join(''), live }
  }
  if (point === 'terminal') return { text: ` -la  # ${input.line}\nsecond line` }
  if (point === 'command') {
    if (input.query === 'rate') return { error: 'rate-limited', message: 'slow down' }
    return {
      suggestions: [
        { command: 'ls -la', description: 'list' },
        { command: 'ls -la', description: 'duplicate' },
        { command: '', description: 'empty' },
      ],
    }
  }
  return { error: 'failed', message: 'not served' }
})

const loaded = new Set()
conn.onRequest('ext.assistModels', async ({ action, id }) => {
  if (action === 'list') {
    return {
      lifecycle: true,
      models: [
        { id: 'small', name: 'Small', loaded: loaded.has('small'), idleSecs: 12.7 },
        { id: 'small', name: 'Duplicate' },
        { id: '', name: 'No id' },
        { id: 'big', description: 'x'.repeat(1000), installed: false, loaded: 'yes' },
      ],
    }
  }
  if (id === 'broken') return { ok: false, error: 'runtime refused' }
  if (action === 'load') loaded.add(id)
  else loaded.delete(id)
  return { ok: true }
})

socket.on('close', () => process.exit(0))
conn.listen()
socket.on('connect', async () => {
  await conn.sendRequest('hello', { token: process.env.PINE_TOKEN })
  await conn.sendRequest('ext.setAssistStatus', {
    status: {
      chat: { ready: true, label: 'fake · big' },
      command: { ready: true, label: 'fake · small' },
      input: { ready: false },
      completion: { ready: true },
      terminal: { ready: true, label: 'fake · small' },
    },
    features: [
      { id: 'chat', setting: 'chat', ready: true },
      { id: 'typos', setting: 'level', ready: true },
      { id: 'bogus', setting: 'chat', ready: true },
    ],
    setup: null,
    lastError: 'model busy',
    label: 'fake',
    models: true,
  })
  await conn.sendRequest('ext.registerCommands', {
    commands: ['secret', 'events', 'status', 'shortcuts', 'openui'],
  })
})
