import { spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { type AddressInfo, type Server, type Socket, connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  PortBridge,
  bridgesPorts,
  controlSocketName,
  dataSocketName,
  portBridgeCommand,
} from './portBridge'

let dir: string
const opened: { destroy?: () => void; close?: () => void }[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ostia-bridge-'))
})

afterEach(() => {
  for (const item of opened.splice(0)) {
    item.destroy?.()
    item.close?.()
  }
  rmSync(dir, { recursive: true, force: true })
})

async function until<T>(read: () => T | undefined, ms = 5000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() - start > ms) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function open(dialTimeoutMs?: number): Promise<PortBridge> {
  const bridge = await PortBridge.open(dir, dialTimeoutMs)
  if (!bridge) throw new Error('the bridge did not open')
  opened.push(bridge)
  return bridge
}

function idOf(bridge: PortBridge): string {
  const id = /UNIX-CONNECT:ports-([0-9a-f]+)\.sock /.exec(bridge.command)?.[1]
  if (!id) throw new Error('no id in the bridge command')
  return id
}

function dial(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(path)
    opened.push(socket)
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })
}

interface Supervisor {
  control: Socket
  asked: number[]
}

async function supervise(bridge: PortBridge): Promise<Supervisor> {
  const control = await dial(join(dir, controlSocketName(idOf(bridge))))
  const asked: number[] = []
  control.on('data', (chunk) => {
    for (const line of String(chunk).split('\n')) if (line) asked.push(Number(line))
  })
  await until(() => (bridge.connected ? true : undefined))
  return { control, asked }
}

async function hostPair(): Promise<{ client: Socket; browser: Socket }> {
  const server: Server = createServer()
  opened.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const accepted = new Promise<Socket>((r) => server.once('connection', r))
  const browser = connect((server.address() as AddressInfo).port, '127.0.0.1')
  browser.on('error', () => undefined)
  const client = await accepted
  client.on('error', () => undefined)
  opened.push(browser, client)
  return { client, browser }
}

function collect(socket: Socket): { text: () => string; ended: () => boolean } {
  let text = ''
  let ended = false
  socket.on('data', (chunk) => {
    text += String(chunk)
  })
  socket.on('close', () => {
    ended = true
  })
  socket.on('error', () => undefined)
  return { text: () => text, ended: () => ended }
}

describe('portBridgeCommand', () => {
  it('reads port numbers from the control socket and joins each to 127.0.0.1 on that port only', () => {
    expect(portBridgeCommand('/tmp/ws', 'ab12')).toBe(
      [
        "( trap '' INT QUIT TSTP; cd /tmp/ws || exit; exec </dev/null >/dev/null 2>&1;",
        'socat -u UNIX-CONNECT:ports-ab12.sock - | while read -r port; do',
        `case "$port" in ''|*[!0-9]*) continue;; esac;`,
        'socat UNIX-CONNECT:ports-ab12-"$port".sock TCP:127.0.0.1:"$port" & done ) &',
      ].join(' '),
    )
  })

  it('quotes a folder that holds spaces', () => {
    expect(portBridgeCommand('/tmp/my ws', 'ab12')).toContain("cd '/tmp/my ws' || exit;")
  })
})

describe('bridgesPorts', () => {
  it.each([
    ['linux', true, true],
    ['linux', false, false],
    ['darwin', true, false],
    ['darwin', false, false],
    ['win32', true, false],
  ] as const)('on %s with unix sockets %s answers %s', (platform, unixSockets, expected) => {
    expect(bridgesPorts(platform, unixSockets)).toBe(expected)
  })
})

describe('portBridgeCommand run in a shell', () => {
  const dialedBy = async (lines: string[]): Promise<string[]> => {
    const bin = join(dir, 'bin')
    const work = join(dir, 'work')
    const log = join(dir, 'dialed.log')
    mkdirSync(bin)
    mkdirSync(work)
    writeFileSync(log, '')
    const fake = join(bin, 'socat')
    writeFileSync(
      fake,
      `#!/bin/sh\nif [ "$1" = -u ]; then printf '%s\\n' ${lines.map((l) => `'${l}'`).join(' ')}; else printf '%s\\n' "$2" >>'${log}'; fi\n`,
    )
    chmodSync(fake, 0o755)
    const child = spawn('sh', ['-c', `${portBridgeCommand(work, 'ab12')} wait`], {
      env: { PATH: `${bin}:/usr/bin:/bin` },
    })
    await new Promise((r) => child.once('close', r))
    await new Promise((r) => setTimeout(r, 300))
    return readFileSync(log, 'utf8').split('\n').filter(Boolean)
  }

  it('dials only the lines that are all digits', async () => {
    expect(await dialedBy(['abc', '', '80;id', '$(id)', '8080', '-1'])).toEqual([
      'TCP:127.0.0.1:8080',
    ])
  })

  it('dials every port it is asked for', async () => {
    expect((await dialedBy(['3000', '8080'])).sort()).toEqual([
      'TCP:127.0.0.1:3000',
      'TCP:127.0.0.1:8080',
    ])
  })
})

describe('PortBridge', () => {
  it('is connected only while a supervisor holds its control socket', async () => {
    const bridge = await open()
    expect(bridge.connected).toBe(false)
    const { control } = await supervise(bridge)
    control.destroy()
    await until(() => (bridge.connected ? undefined : true))
  })

  it('asks the supervisor for the port and joins the client to the connection it brings', async () => {
    const bridge = await open()
    const supervisor = await supervise(bridge)
    const { client, browser } = await hostPair()
    const seen = collect(browser)
    await bridge.dial(4321, client)
    await until(() => (supervisor.asked.length > 0 ? true : undefined))
    expect(supervisor.asked).toEqual([4321])
    const inside = await dial(join(dir, dataSocketName(idOf(bridge), 4321)))
    const reached = collect(inside)
    inside.write('from-inside')
    browser.write('from-host')
    await until(() => (seen.text() === 'from-inside' ? true : undefined))
    await until(() => (reached.text() === 'from-host' ? true : undefined))
    inside.destroy()
    await until(() => (seen.ended() ? true : undefined))
  })

  it('joins clients to connections in the order they asked, per port', async () => {
    const bridge = await open()
    const supervisor = await supervise(bridge)
    const first = await hostPair()
    const second = await hostPair()
    const other = await hostPair()
    await bridge.dial(4000, first.client)
    await bridge.dial(5000, other.client)
    await bridge.dial(4000, second.client)
    await until(() => (supervisor.asked.length === 3 ? true : undefined))
    expect(supervisor.asked).toEqual([4000, 5000, 4000])
    const seen = [collect(first.browser), collect(second.browser), collect(other.browser)]
    const id = idOf(bridge)
    ;(await dial(join(dir, dataSocketName(id, 4000)))).write('a')
    await until(() => (seen[0].text() === 'a' ? true : undefined))
    ;(await dial(join(dir, dataSocketName(id, 5000)))).write('c')
    ;(await dial(join(dir, dataSocketName(id, 4000)))).write('b')
    await until(() => (seen[1].text() === 'b' && seen[2].text() === 'c' ? true : undefined))
  })

  it('closes a connection to a data socket that no client is waiting on', async () => {
    const bridge = await open()
    await supervise(bridge)
    const { client, browser } = await hostPair()
    await bridge.dial(4321, client)
    const path = join(dir, dataSocketName(idOf(bridge), 4321))
    const wanted = await dial(path)
    wanted.write('x')
    const unasked = collect(await dial(path))
    await until(() => (unasked.ended() ? true : undefined))
    expect(unasked.text()).toBe('')
    expect(browser.destroyed).toBe(false)
  })

  it('closes the client when no supervisor is connected, and asks nothing', async () => {
    const bridge = await open()
    const { client, browser } = await hostPair()
    const seen = collect(browser)
    await bridge.dial(4321, client)
    await until(() => (seen.ended() ? true : undefined))
  })

  it('closes the client when the supervisor brings no connection in time', async () => {
    const bridge = await open(50)
    const supervisor = await supervise(bridge)
    const { client, browser } = await hostPair()
    const seen = collect(browser)
    await bridge.dial(4321, client)
    await until(() => (seen.ended() ? true : undefined))
    expect(supervisor.asked).toEqual([4321])
    const late = collect(await dial(join(dir, dataSocketName(idOf(bridge), 4321))))
    await until(() => (late.ended() ? true : undefined))
  })

  it('keeps the first supervisor and closes a second control connection', async () => {
    const bridge = await open()
    const supervisor = await supervise(bridge)
    const second = collect(await dial(join(dir, controlSocketName(idOf(bridge)))))
    await until(() => (second.ended() ? true : undefined))
    const { client } = await hostPair()
    await bridge.dial(4321, client)
    await until(() => (supervisor.asked.length > 0 ? true : undefined))
    expect(second.text()).toBe('')
  })

  it('never follows a link left where its data socket goes', async () => {
    const bridge = await open()
    await supervise(bridge)
    const decoy: Server = createServer()
    opened.push(decoy)
    const decoyPath = join(dir, 'decoy.sock')
    let reachedDecoy = false
    decoy.on('connection', () => {
      reachedDecoy = true
    })
    await new Promise<void>((r) => decoy.listen(decoyPath, r))
    const path = join(dir, dataSocketName(idOf(bridge), 4321))
    symlinkSync(decoyPath, path)
    const { client } = await hostPair()
    await bridge.dial(4321, client)
    expect(lstatSync(path).isSocket()).toBe(true)
    expect(reachedDecoy).toBe(false)
  })

  it('removes its sockets and drops every connection when closed', async () => {
    const bridge = await open()
    const supervisor = await supervise(bridge)
    const waiting = await hostPair()
    const joined = await hostPair()
    await bridge.dial(4321, joined.client)
    const inside = collect(await dial(join(dir, dataSocketName(idOf(bridge), 4321))))
    await bridge.dial(4321, waiting.client)
    const ends = [collect(waiting.browser), collect(joined.browser), collect(supervisor.control)]
    bridge.close()
    await until(() => (ends.every((e) => e.ended()) && inside.ended() ? true : undefined))
    await until(() => (readdirSync(dir).length === 0 ? true : undefined))
    expect(existsSync(join(dir, controlSocketName(idOf(bridge))))).toBe(false)
  })
})
