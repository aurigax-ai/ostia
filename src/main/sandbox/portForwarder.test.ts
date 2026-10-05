import { mkdtempSync, rmSync } from 'node:fs'
import { type AddressInfo, type Server, type Socket, connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PortBridge, controlSocketName, dataSocketName } from './portBridge'
import { PortForwarder, type SandboxListener, type SandboxPane } from './portForwarder'

let dir: string
const opened: { destroy?: () => void; close?: () => void; stopAll?: () => void }[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ostia-forward-'))
})

afterEach(() => {
  for (const item of opened.splice(0)) {
    item.stopAll?.()
    item.destroy?.()
    item.close?.()
  }
  rmSync(dir, { recursive: true, force: true })
})

async function until<T>(read: () => T | undefined | Promise<T | undefined>, ms = 5000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() - start > ms) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 10))
  }
}

function idOf(bridge: PortBridge): string {
  return /UNIX-CONNECT:ports-([0-9a-f]+)\.sock /.exec(bridge.command)?.[1] ?? ''
}

function dial(target: string | number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = typeof target === 'number' ? connect(target, '127.0.0.1') : connect(target)
    opened.push(socket)
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })
}

async function freePort(): Promise<number> {
  const probe: Server = createServer()
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r))
  const { port } = probe.address() as AddressInfo
  await new Promise((r) => probe.close(r))
  return port
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe: Server = createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

interface FakePane extends SandboxPane {
  bridge: PortBridge
  asked: number[]
}

async function sandboxPane(pid: number, name: string): Promise<FakePane> {
  const bridge = await PortBridge.open(dir)
  if (!bridge) throw new Error('the bridge did not open')
  opened.push(bridge)
  const control = await dial(join(dir, controlSocketName(idOf(bridge))))
  const asked: number[] = []
  control.on('data', (chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (!line) continue
      asked.push(Number(line))
      void dial(join(dir, dataSocketName(idOf(bridge), Number(line)))).then((inside) =>
        inside.end(`${name}:${line}`),
      )
    }
  })
  await until(() => (bridge.connected ? true : undefined))
  return { pid, bridge, asked }
}

function setup(
  panes: SandboxPane[],
  listening: Record<number, SandboxListener[]> = {},
  unixSocketsOff = false,
): PortForwarder {
  const forwarder = new PortForwarder({
    panesOf: (workspaceId) => (workspaceId === 'ws' ? panes : []),
    unixSocketsOff: () => unixSocketsOff,
    listenersOf: (pids) => pids.map((pid) => listening[pid] ?? []),
  })
  opened.push(forwarder)
  return forwarder
}

async function read(port: number): Promise<string> {
  const socket = await dial(port)
  let text = ''
  socket.on('data', (chunk) => {
    text += String(chunk)
  })
  await new Promise((r) => socket.once('close', r))
  return text
}

describe('PortForwarder', () => {
  it('refuses to expose a port while no sandboxed terminal runs, and binds nothing', async () => {
    const port = await freePort()
    const forwarder = setup([])
    expect(forwarder.refusal('ws')).toBe('not-running')
    await expect(forwarder.expose('ws', port)).resolves.toEqual({ ok: false, error: 'not-running' })
    expect(await portFree(port)).toBe(true)
    expect(forwarder.exposed('ws')).toEqual([])
  })

  it('says Unix sockets are off when no terminal of the sandbox has a bridge and the switch is off', async () => {
    const port = await freePort()
    const forwarder = setup([{ pid: 11, bridge: null }], { 11: [{ port, process: 'node' }] }, true)
    expect(forwarder.refusal('ws')).toBe('unix-sockets-off')
    await expect(forwarder.expose('ws', port)).resolves.toEqual({
      ok: false,
      error: 'unix-sockets-off',
    })
    expect(await portFree(port)).toBe(true)
  })

  it('waits for a bridge rather than blaming the switch while Unix sockets are on', () => {
    expect(setup([{ pid: 11, bridge: null }]).refusal('ws')).toBe('not-running')
  })

  it('exposes through a terminal that started with a bridge even after the switch went off', async () => {
    const port = await freePort()
    const pane = await sandboxPane(11, 'a')
    const forwarder = setup([pane], { 11: [{ port, process: 'node' }] }, true)
    expect(forwarder.refusal('ws')).toBeNull()
    await expect(forwarder.expose('ws', port)).resolves.toEqual({ ok: true, port })
    expect(await read(port)).toBe(`a:${port}`)
  })

  it('sends a host connection to the terminal whose sandbox listens on the port', async () => {
    const port = await freePort()
    const first = await sandboxPane(11, 'first')
    const second = await sandboxPane(22, 'second')
    const forwarder = setup([first, second], {
      11: [{ port: port + 1, process: 'node' }],
      22: [{ port, process: 'node' }],
    })
    await forwarder.expose('ws', port)
    expect(await read(port)).toBe(`second:${port}`)
    expect(first.asked).toEqual([])
    expect(second.asked).toEqual([port])
  })

  it('closes a host connection when nothing in the sandbox listens on the exposed port', async () => {
    const port = await freePort()
    const pane = await sandboxPane(11, 'a')
    const forwarder = setup([pane], { 11: [{ port: port + 1, process: 'node' }] })
    await forwarder.expose('ws', port)
    expect(await read(port)).toBe('')
    expect(pane.asked).toEqual([])
  })

  it('never asks a terminal without a bridge, even when its sandbox listens on the port', async () => {
    const port = await freePort()
    const bridged = await sandboxPane(11, 'a')
    const forwarder = setup([{ pid: 22, bridge: null }, bridged], {
      22: [{ port, process: 'node' }],
    })
    await forwarder.expose('ws', port)
    expect(await read(port)).toBe('')
    expect(bridged.asked).toEqual([])
  })

  it('lists the servers of every terminal once, by port', () => {
    const forwarder = setup(
      [
        { pid: 11, bridge: null },
        { pid: 22, bridge: null },
      ],
      {
        11: [
          { port: 5173, process: 'node' },
          { port: 3000, process: 'bun' },
        ],
        22: [
          { port: 8000, process: 'python' },
          { port: 3000, process: 'node' },
        ],
      },
    )
    expect(forwarder.listeners('ws')).toEqual([
      { port: 3000, process: 'bun' },
      { port: 5173, process: 'node' },
      { port: 8000, process: 'python' },
    ])
  })

  it('drops live connections and frees the host port when the port is unexposed', async () => {
    const port = await freePort()
    const bridge = await PortBridge.open(dir)
    if (!bridge) throw new Error('the bridge did not open')
    opened.push(bridge)
    await dial(join(dir, controlSocketName(idOf(bridge))))
    await until(() => (bridge.connected ? true : undefined))
    const forwarder = setup([{ pid: 11, bridge }], { 11: [{ port, process: 'node' }] })
    await forwarder.expose('ws', port)
    const held = await dial(port)
    let closed = false
    held.on('close', () => {
      closed = true
    })
    await forwarder.unexpose('ws', port)
    await until(() => (closed ? true : undefined))
    expect(await until(async () => ((await portFree(port)) ? true : undefined))).toBe(true)
  })
})
