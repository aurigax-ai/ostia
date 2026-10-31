import { execFile } from 'node:child_process'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { CommandResult } from '../../shared/control/commands'
import { registerControlMethod, registerControlServer, stopControlServer } from './controlServer'
import { registerPane } from './idRegistry'

const SANDBOXED_REFUSAL_TEXT = 'sandboxed:'

const CLIENT = `
const net = require('node:net')
const koffi = require('koffi')
const { createMessageConnection, StreamMessageReader, StreamMessageWriter } = require('vscode-jsonrpc/node')
const [path, token, filtered] = process.argv.slice(1)
if (filtered === 'yes') {
  const libc = koffi.load('libc.so.6')
  const Insn = koffi.struct('Insn', { code: 'uint16', jt: 'uint8', jf: 'uint8', k: 'uint32' })
  const Prog = koffi.struct('Prog', { len: 'uint16', filter: koffi.pointer(Insn) })
  const prctl = libc.func('int prctl(int option, unsigned long a, Prog *b, unsigned long c, unsigned long d)')
  const view = { len: 1, filter: [{ code: 6, jt: 0, jf: 0, k: 0x7fff0000 }] }
  if (prctl(38, 1, null, 0, 0) !== 0) process.exit(3)
  if (prctl(22, 2, view, 0, 0) !== 0) process.exit(4)
}
const socket = net.createConnection(path)
const conn = createMessageConnection(new StreamMessageReader(socket), new StreamMessageWriter(socket))
conn.listen()
const call = (m, p) => conn.sendRequest(m, p).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e: e.message }))
;(async () => {
  await conn.sendRequest('hello', { token })
  const out = { run: await call('process.run', { cmd: 'true' }), bus: await call('bus.send', {}) }
  process.stdout.write(JSON.stringify(out))
  socket.destroy()
})()
`

let socketPath = ''

type Outcome = { ok: boolean; e?: string }

function client(token: string, filtered: boolean): Promise<{ run: Outcome; bus: Outcome }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['-e', CLIENT, socketPath, token, filtered ? 'yes' : 'no'],
      { encoding: 'utf8', cwd: process.cwd(), timeout: 20_000 },
      (err, stdout, stderr) =>
        err ? reject(new Error(`${err.message} ${stderr}`)) : resolve(JSON.parse(stdout)),
    )
  })
}

describe.skipIf(process.platform !== 'linux')(
  'control socket refuses a kernel-sandboxed caller',
  () => {
    beforeAll(() => {
      registerControlMethod('process.run', { handler: async () => ({ started: true }) })
      registerControlMethod('bus.send', { handler: async () => ({ sent: true }) })
    })

    afterEach(() => {
      stopControlServer()
      rmSync(socketPath, { force: true })
    })

    function serve(shellPid: number) {
      socketPath = join(tmpdir(), `ostia-peer-${process.pid}-${Date.now()}.sock`)
      registerControlServer(
        {
          isSandboxed: () => false,
          ptyPid: () => shellPid,
          execCommand: async () => ({ ok: true, result: null }) as CommandResult,
          listCommandsFor: () => [],
          getTerminalState: () => undefined,
        },
        socketPath,
      )
      return registerPane({ windowId: 'w1', workspaceId: 's1', paneId: `pPeer${Date.now()}` })
    }

    it('refuses process.run and allows bus.send under a seccomp filter', async () => {
      const id = serve(process.pid)
      await new Promise((resolve) => setTimeout(resolve, 100))
      const out = await client(id.token, true)
      expect(out.run.ok).toBe(false)
      expect(out.run.e).toContain(SANDBOXED_REFUSAL_TEXT)
      expect(out.bus.ok).toBe(true)
    })

    it('allows both without a filter', async () => {
      const id = serve(process.pid)
      await new Promise((resolve) => setTimeout(resolve, 100))
      const out = await client(id.token, false)
      expect(out.run.ok).toBe(true)
      expect(out.bus.ok).toBe(true)
    })
  },
)
