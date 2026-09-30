import { mkdtempSync, rmSync } from 'node:fs'
import { type Server, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import {
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
} from 'vscode-jsonrpc/node'
import { connectPortal, runPortalCommand, stripDetach } from './portal'

let dir = ''
let server: Server | null = null

afterEach(() => {
  server?.close()
  server = null
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

function socketPath(): string {
  dir = mkdtempSync(join(tmpdir(), 'pine-cli-portal-'))
  return join(dir, 'portal.sock')
}

function listen(path: string): Promise<void> {
  server = createServer((s) => s.end())
  return new Promise((resolve) => server?.listen(path, resolve))
}

describe('connectPortal', () => {
  it('connects straight away when Pine is already running, without launching it', async () => {
    const path = socketPath()
    await listen(path)
    const launches: string[] = []
    const socket = await connectPortal(path, { PINE_APP_BIN: '/opt/pine' }, (bin) => {
      launches.push(bin)
    })
    expect(typeof socket).not.toBe('string')
    if (typeof socket !== 'string') socket.destroy()
    expect(launches).toEqual([])
  })

  it('MGR-C7 starts Pine hidden when it is not running and waits for the portal', async () => {
    const path = socketPath()
    const launches: { bin: string; node?: string }[] = []
    const socket = await connectPortal(
      path,
      { PINE_APP_BIN: '/opt/pine/pine', ELECTRON_RUN_AS_NODE: '1' },
      (bin, env) => {
        launches.push({ bin, node: env.ELECTRON_RUN_AS_NODE })
        setTimeout(() => void listen(path), 300)
      },
    )
    expect(typeof socket).not.toBe('string')
    if (typeof socket !== 'string') socket.destroy()
    expect(launches).toEqual([{ bin: '/opt/pine/pine', node: '1' }])
  })

  it('MGR-C8 gives up with a message when Pine does not come up in time, launching once', async () => {
    const path = socketPath()
    let launches = 0
    const result = await connectPortal(
      path,
      { PINE_APP_BIN: '/opt/pine/pine' },
      () => {
        launches++
      },
      600,
    )
    expect(result).toBe('Pine did not start within 1 s')
    expect(launches).toBe(1)
  })

  it('MGR-C8 says Pine is not running when it does not know where Pine is installed', async () => {
    const result = await connectPortal(socketPath(), {}, () => {
      throw new Error('must not launch')
    })
    expect(result).toMatch(/Pine is not running/)
  })
})

describe('stripDetach', () => {
  it('MGR-C22 cuts the input at Ctrl+\\ and asks to detach', () => {
    expect(stripDetach('ab\x1ccd')).toEqual({ input: 'ab', detach: true })
    expect(stripDetach('plain')).toEqual({ input: 'plain', detach: false })
  })
})

function fakeTty() {
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: () => stdin,
  }) as unknown as NodeJS.ReadStream
  const stdout = Object.assign(new PassThrough(), {
    isTTY: true,
    columns: 100,
    rows: 30,
  }) as unknown as NodeJS.WriteStream
  return { stdin, stdout }
}

describe('runPortalCommand', () => {
  it('MGR-C22 keeps keys typed before the manager attaches and sends them after', async () => {
    const path = socketPath()
    const inputs: string[] = []
    let answerOpen: () => void = () => {}
    server = createServer((socket) => {
      const conn = createMessageConnection(
        new StreamMessageReader(socket),
        new StreamMessageWriter(socket),
      )
      conn.onRequest(
        'portal.open',
        () =>
          new Promise((resolve) => {
            answerOpen = () => resolve({ paneId: 'p', agent: 'claude', created: true })
          }),
      )
      conn.onNotification('mirror.input', (p: { data: string }) => {
        inputs.push(p.data)
      })
      conn.listen()
    })
    await new Promise<void>((resolve) => server?.listen(path, resolve))

    const { stdin, stdout } = fakeTty()
    const run = runPortalCommand(['claude'], {
      stdin,
      stdout,
      stderr: new PassThrough(),
      env: { PINE_PORTAL_SOCKET: path },
      cwd: '/home/u',
    })
    await new Promise((r) => setTimeout(r, 50))
    stdin.write('early keys')
    await new Promise((r) => setTimeout(r, 50))
    expect(inputs).toEqual([])
    answerOpen()
    await new Promise((r) => setTimeout(r, 50))
    expect(inputs).toEqual(['early keys'])

    stdin.write('\x1c')
    await expect(run).resolves.toBe(0)
  })
})
