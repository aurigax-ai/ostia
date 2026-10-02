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
  if (command !== 'on-hook') return { ok: false, error: 'unknown' }
  const [agent, event] = args.argv
  const input = JSON.parse(args.stdin)
  await conn.sendRequest('ext.notify', {
    title: `agent-kit ${agent} ${event}`,
    body: `${input.session_id} ${input.tool_name ?? ''}`.trim(),
  })
  return { ok: true, text: `agent-kit saw ${agent} ${event} for ${input.session_id}` }
})

socket.on('close', () => process.exit(0))
conn.listen()

socket.on('connect', async () => {
  await conn.sendRequest('hello', { token: process.env.PINE_TOKEN })
  await conn.sendRequest('ext.registerCommands', { commands: ['on-hook'] })
})
