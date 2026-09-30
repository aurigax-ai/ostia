import { createInterface } from 'node:readline'

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo the text back',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'env',
    description: 'Read one environment variable of the server',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  { name: 'fail', description: 'Always fails', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'slow',
    description: 'Answers after a delay',
    inputSchema: { type: 'object', properties: { ms: { type: 'number' } } },
  },
  { name: 'exit', description: 'Stops the server', inputSchema: { type: 'object', properties: {} } },
]

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function text(value, isError = false) {
  return { content: [{ type: 'text', text: value }], isError }
}

async function call(name, args) {
  if (name === 'echo') return text(`echo: ${args.text ?? ''}`)
  if (name === 'env') return text(process.env[args.name] ?? '(unset)')
  if (name === 'fail') return text('boom', true)
  if (name === 'slow') {
    await new Promise((resolve) => setTimeout(resolve, Number(args.ms ?? 1000)))
    return text('slow done')
  }
  if (name === 'exit') process.exit(1)
  return null
}

async function handle(message) {
  if (message.id === undefined) return
  const { id, method, params = {} } = message
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp', version: '1.0.0' },
      },
    })
    return
  }
  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} })
    return
  }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
    return
  }
  if (method === 'tools/call') {
    const result = await call(params.name, params.arguments ?? {})
    if (result) send({ jsonrpc: '2.0', id, result })
    else send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${params.name}` } })
    return
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}` } })
}

const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  if (!line.trim()) return
  void handle(JSON.parse(line))
})
lines.on('close', () => process.exit(0))
