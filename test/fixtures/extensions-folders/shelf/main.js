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

const files = new Map([['/srv/app/notes.txt', { content: 'hello\n', version: '1-6' }]])
const closed = []
const asked = []

function answer(req) {
  if (req.op === 'list') {
    if (req.path === '/srv/app/hostile') {
      return {
        ok: true,
        entries: [
          { name: 'fine.txt', dir: false },
          { name: '../../etc/passwd', dir: false },
          { name: 'bell\u0007', dir: false },
          { name: '..', dir: true },
          { name: 'fine.txt', dir: true },
          { name: 42, dir: false },
          null,
        ],
      }
    }
    return {
      ok: true,
      entries: [
        { name: 'notes.txt', dir: false },
        { name: 'src', dir: true },
      ],
    }
  }
  if (req.op === 'stat') {
    const file = files.get(req.path)
    return file ? { ok: true, kind: 'file', version: file.version } : { ok: true, kind: 'dir' }
  }
  if (req.op === 'read') {
    if (req.path === '/srv/app/nul.bin') return { ok: true, content: 'a\u0000b', version: '1-3' }
    if (req.path === '/srv/app/odd-version') return { ok: true, content: 'x', version: 'has space' }
    if (req.path === '/srv/app/slow') return new Promise(() => {})
    const file = files.get(req.path)
    return file ? { ok: true, ...file } : { ok: false, error: 'not-found' }
  }
  if (req.op === 'write') {
    const file = files.get(req.path)
    const current = file ? file.version : 'new'
    if (req.baseVersion !== 'any' && req.baseVersion !== current) {
      return { ok: false, error: 'changed' }
    }
    const version = `2-${req.content.length}`
    files.set(req.path, { content: req.content, version })
    return { ok: true, version }
  }
  return { ok: false, error: 'failed' }
}

conn.onRequest('ext.files', (req) => {
  asked.push({ op: req.op, folderId: req.folderId, root: req.root, path: req.path })
  return answer(req)
})

conn.onNotification('ext.event', ({ type, payload }) => {
  if (type === 'folder.closed') closed.push(payload.folderId)
})

conn.onRequest('ext.command', async ({ command, args }) => {
  try {
    if (command === 'open')
      return { ok: true, data: await conn.sendRequest('ext.openFolder', args) }
    if (command === 'close')
      return { ok: true, data: await conn.sendRequest('ext.closeFolder', args) }
    if (command === 'closed') return { ok: true, data: closed }
    if (command === 'asked') return { ok: true, data: asked.splice(0) }
  } catch (err) {
    return { ok: false, error: 'rpc', message: err.message }
  }
  return { ok: false, error: 'unknown' }
})

socket.on('close', () => process.exit(0))
conn.listen()

socket.on('connect', async () => {
  await conn.sendRequest('hello', { token: process.env.OSTIA_TOKEN })
  const commands = require('./ostia.json').contributes.commands.map((c) => c.id)
  await conn.sendRequest('ext.registerCommands', { commands })
})
