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

let entries = []
let events = 0

function report() {
  return conn.sendRequest('ext.setAssistStatus', {
    status: { chat: { ready: true }, command: { ready: true } },
    features: [{ id: 'chat', setting: 'chat', ready: true }],
    setup: entries.length === 0 ? 'no-provider' : null,
    models: true,
    kinds: [
      { id: 'plain', title: 'Plain', baseUrl: 'http://plain.example/v1', key: 'optional' },
      { id: 'keyed', title: 'Keyed', baseUrl: '', key: 'required' },
      { id: 'Bad Kind', title: 'Dropped' },
    ],
    providers: entries.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      name: entry.name,
      setup: entry.kind === 'keyed' && !entry.apiKey ? 'no-key' : null,
      lifecycle: false,
      models: entry.models.map((id) => ({
        id,
        tools: id.startsWith('small') ? 'prompted' : 'native',
      })),
    })),
  })
}

conn.onRequest('ext.command', async ({ command }) => {
  if (command === 'entries') return { ok: true, data: { entries, events } }
  return { ok: false, error: 'unknown-command' }
})

conn.onNotification('ext.event', async ({ type, payload }) => {
  if (type !== 'assist.providers.changed') return
  events += 1
  entries = payload.providers
  await report()
})

conn.onRequest('ext.assist', async ({ point, input, model }) => {
  const target = model ? `${model.provider}/${model.model}` : 'no-model'
  if (point === 'chat') return { text: `${target} answers ${input.messages.at(-1).content}` }
  return { suggestions: [{ command: target }] }
})

conn.onRequest('ext.assistModels', async ({ action, provider }) => {
  if (action !== 'list') return { ok: false, error: 'no lifecycle' }
  return { lifecycle: false, models: [{ id: `${provider ?? 'none'}-listed` }] }
})

socket.on('close', () => process.exit(0))
conn.listen()
socket.on('connect', async () => {
  await conn.sendRequest('hello', { token: process.env.OSTIA_TOKEN })
  const res = await conn.sendRequest('ext.assistProviders')
  entries = res.providers
  await report()
  await conn.sendRequest('ext.registerCommands', { commands: ['entries'] })
})
