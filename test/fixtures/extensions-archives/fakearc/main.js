const { execFileSync } = require('node:child_process')
const { mkdirSync, renameSync, symlinkSync, writeFileSync } = require('node:fs')
const { createConnection } = require('node:net')
const { basename, dirname, join } = require('node:path')
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

const asked = []

function entry(name, index, extra = {}) {
  return { name, index, dir: false, size: 5, encrypted: false, link: null, ...extra }
}

const LISTS = {
  tree: () => [
    entry('docs/', 0, { dir: true, size: 0 }),
    entry('docs/readme.txt', 1),
    entry('top.csv', 2, { size: 3 }),
  ],
  huge: () => Array.from({ length: 20_001 }, (_unused, i) => entry(`f${i}.txt`, i)),
  deep: () => [entry(`${Array.from({ length: 33 }, (_unused, i) => `d${i}`).join('/')}/x.txt`, 0)],
  names: () => [entry('../up.txt', 0), entry('/abs/file', 1), entry('bell\u0007.txt', 2)],
  wide: () => Array.from({ length: 400 }, (_unused, i) => entry(`${'n'.repeat(1000)}${i}`, i)),
  special: () => [
    entry('passwd', 0, { link: '../../etc/passwd', size: 0 }),
    entry('secret.txt', 1, { encrypted: true }),
    entry('big.bin', 2, { size: 1024 * 1024 * 1024 }),
    entry('ok.txt', 3),
  ],
}

function stem(path) {
  return basename(path).replace(/\.fake$/, '')
}

function list(req, token) {
  const name = stem(req.archive)
  if (name.startsWith('hang')) return new Promise(() => {})
  if (name === 'slow') {
    return new Promise((resolve) => {
      token.onCancellationRequested(() =>
        resolve({ ok: true, entries: [entry('early.txt', 0)], complete: false }),
      )
    })
  }
  if (name.startsWith('crash')) process.exit(1)
  if (name === 'partial') return { ok: true, entries: [entry('first.txt', 0)], complete: false }
  if (name === 'bad') return { ok: true, entries: [{ name: 42 }], complete: true }
  if (name === 'failed') return { ok: false, error: 'failed' }
  const make = LISTS[name] ?? LISTS.tree
  return { ok: true, entries: make(), complete: true }
}

function read(req) {
  const name = stem(req.archive)
  if (name === 'stuck') return new Promise(() => {})
  if (name === 'symlink') {
    writeFileSync(`${req.out}.target`, 'hello')
    symlinkSync(`${req.out}.target`, req.out)
    return { ok: true, size: 5 }
  }
  if (name === 'fifo') {
    execFileSync('mkfifo', [req.out])
    return { ok: true, size: 5 }
  }
  if (name === 'liar') {
    writeFileSync(req.out, '0123456789')
    return { ok: true, size: 5 }
  }
  if (name === 'over') {
    writeFileSync(req.out, Buffer.alloc(req.max + 1))
    return { ok: true, size: req.max + 1 }
  }
  if (name === 'elsewhere') {
    writeFileSync(`${req.out}.x`, 'hello')
    return { ok: true, size: 5 }
  }
  if (name === 'dirlink') {
    const dir = dirname(req.out)
    const other = `${dir}-other`
    renameSync(dir, other)
    symlinkSync(other, dir)
    writeFileSync(join(other, basename(req.out)), 'hello')
    return { ok: true, size: 5 }
  }
  if (name === 'gone') return { ok: false, error: 'gone' }
  if (name === 'bomb') return { ok: false, error: 'unzip-limit' }
  const data = req.index === 2 ? 'a,b' : 'hello'
  mkdirSync(dirname(req.out), { recursive: true })
  writeFileSync(req.out, data, { flag: 'wx', mode: 0o600 })
  return { ok: true, size: Buffer.byteLength(data) }
}

conn.onRequest('ext.archive', (req, token) => {
  asked.push(req)
  return req.op === 'list' ? list(req, token) : read(req)
})

conn.onRequest('ext.command', ({ command }) => {
  if (command === 'asked') return { ok: true, data: asked.splice(0) }
  return { ok: false, error: 'unknown' }
})

socket.on('close', () => process.exit(0))
conn.listen()

socket.on('connect', async () => {
  await conn.sendRequest('hello', { token: process.env.OSTIA_TOKEN })
  await conn.sendRequest('ext.registerCommands', { commands: ['asked'] })
})
