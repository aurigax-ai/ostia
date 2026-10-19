import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'

const require = createRequire(`${process.cwd()}/`)
const { WebSocketServer } = require(process.env.FAKE_CODEX_WS)

const args = process.argv.slice(2)
const listen = args.indexOf('--listen')
if (!args.includes('app-server') || listen < 0) process.exit(2)
const socket = args[listen + 1].replace(/^unix:\/\//, '')
const log = process.env.FAKE_CODEX_LOG
const record = (entry) => appendFileSync(log, `${JSON.stringify(entry)}\n`)

record({ started: args, cwd: process.cwd(), codexArgs: process.env.OSTIA_CODEX_ARGS ?? null })

const server = createServer()
const wss = new WebSocketServer({ server })
wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    const message = JSON.parse(String(data))
    record({ received: message })
    if (message.id === undefined) return
    if (message.method === 'initialize') {
      ws.send(JSON.stringify({ id: message.id, result: { userAgent: 'fake-codex' } }))
    } else if (message.method === 'turn/start' && message.params.threadId === 'refuse-me') {
      ws.send(JSON.stringify({ id: message.id, error: { code: -32000, message: 'no such thread' } }))
    } else if (message.method === 'turn/start') {
      ws.send(JSON.stringify({ id: message.id, result: { turn: { id: 'turn-1' } } }))
    } else {
      ws.send(JSON.stringify({ id: message.id, error: { code: -32601, message: 'unknown method' } }))
    }
  })
})
server.listen(socket)
process.on('SIGTERM', () => {
  record({ stopped: true })
  process.exit(0)
})
