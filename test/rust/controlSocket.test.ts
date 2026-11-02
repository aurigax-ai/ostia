import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node'
import { registerControlServer, stopControlServer } from '../../src/main/control/controlServer'
import { registerPane } from '../../src/main/control/idRegistry'
import type { TerminalStateSnapshot } from '../../src/shared/terminal/ptyApi'
import { launchRustApp } from './rustApp'

interface Target {
  socket: string
  token: string
  externalId: string
  stop: () => Promise<void>
}

const TERMINAL_STATE: TerminalStateSnapshot = {
  paneId: 'p1',
  generation: 1,
  cwd: '/',
  running: false,
  blockCount: 0,
}

async function startTs(): Promise<Target> {
  const socket = join(tmpdir(), `ostia-parity-${process.pid}.sock`)
  const identity = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'p1' })
  registerControlServer(
    {
      execCommand: async () => ({ ok: true }),
      listCommandsFor: () => [],
      getTerminalState: () => TERMINAL_STATE,
      isSandboxed: () => false,
    },
    socket,
  )
  return {
    socket,
    token: identity.token,
    externalId: identity.externalId,
    stop: async () => stopControlServer(),
  }
}

async function startRust(): Promise<Target> {
  const app = await launchRustApp({ panes: ['w1:s1:p1'] })
  const [pane] = app.panes
  return { socket: app.socket, token: pane.token, externalId: pane.externalId, stop: app.stop }
}

function connect(path: string): { conn: MessageConnection; close: () => void } {
  const socket = createConnection(path)
  const conn = createMessageConnection(
    new StreamMessageReader(socket),
    new StreamMessageWriter(socket),
  )
  conn.listen()
  return {
    conn,
    close: () => {
      conn.dispose()
      socket.destroy()
    },
  }
}

describe.each([
  ['the TS app', startTs],
  ['the Rust app', startRust],
])('the control socket of %s', (_name, start) => {
  let target: Target

  beforeAll(async () => {
    target = await start()
  })

  afterAll(async () => {
    await target.stop()
  })

  it('answers hello with the external id of the token', async () => {
    const { conn, close } = connect(target.socket)
    await expect(conn.sendRequest('hello', { token: target.token })).resolves.toEqual({
      externalId: target.externalId,
    })
    close()
  })

  it('refuses a bogus token with the same code and text', async () => {
    const { conn, close } = connect(target.socket)
    await expect(conn.sendRequest('hello', { token: 'bogus' })).rejects.toMatchObject({
      code: -32600,
      message: 'invalid or missing token',
    })
    close()
  })

  it('refuses whoami before hello with the same code and text', async () => {
    const { conn, close } = connect(target.socket)
    await expect(conn.sendRequest('whoami')).rejects.toMatchObject({
      code: -32600,
      message: 'call hello first',
    })
    close()
  })

  it('answers whoami with the same fields', async () => {
    const { conn, close } = connect(target.socket)
    await conn.sendRequest('hello', { token: target.token })
    await expect(conn.sendRequest('whoami')).resolves.toEqual({
      externalId: target.externalId,
      paneId: 'p1',
      workspaceId: 's1',
    })
    close()
  })

  it('answers pane.info with the same fields', async () => {
    const { conn, close } = connect(target.socket)
    await conn.sendRequest('hello', { token: target.token })
    await expect(conn.sendRequest('pane.info')).resolves.toEqual(TERMINAL_STATE)
    close()
  })

  it('answers an unknown method with the same code and text', async () => {
    const { conn, close } = connect(target.socket)
    await expect(conn.sendRequest('no.such')).rejects.toMatchObject({
      code: -32601,
      message: 'Unhandled method no.such',
    })
    close()
  })

  it('closes the connection on a message over the cap', async () => {
    const socket = createConnection(target.socket)
    const closed = new Promise((resolve) => socket.once('close', resolve))
    socket.on('error', () => {})
    socket.write('Content-Length: 99999999999\r\n\r\n')
    await closed
  })
})
