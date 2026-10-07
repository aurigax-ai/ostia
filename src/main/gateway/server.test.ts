import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { emitPlatformEvent } from '../events'
import { registerPane } from '../idRegistry'
import type { GatewayControlDeps } from './controlDispatch'
import { registerDevice } from './devices'

const registeredMethods = vi.hoisted(() => [] as string[])

vi.mock('electron', () => ({
  app: { getPath: () => process.env.XDG_DATA_HOME, getVersion: () => '0.0.0-test' },
  ipcMain: { handle: () => {} },
}))

vi.mock('../controlServer', () => ({
  registerControlMethod: (name: string) => registeredMethods.push(name),
}))

const { configureGatewayControl, phoneCanRespond, startGateway, stopGateway } = await import(
  './server'
)
const { gatewaySetCap, registerGatewayMethods } = await import('./index')

type Json = {
  id?: unknown
  method?: string
  result?: unknown
  error?: { code: number; data?: unknown }
  params?: { type: string; payload: unknown }
}

interface Client {
  ws: WebSocket
  json: Json[]
  closed: Promise<number>
  next: (pred: (m: Json) => boolean) => Promise<Json>
  call: (method: string, params?: unknown) => Promise<Json>
}

let port = 0
let seq = 0
const deps = {
  execCommand: vi.fn().mockResolvedValue({ ok: true, result: null }),
  listCommandsFor: vi.fn().mockReturnValue([
    {
      id: 'pane.splitRight',
      title: 'Split right',
      hidden: false,
      argsSchema: null,
      resultSchema: null,
      capabilities: ['drive-self'],
      target: 'active',
    },
  ]),
  getTerminalState: vi.fn(),
  listPanes: vi.fn().mockResolvedValue([]),
  listWorkspaces: vi.fn().mockResolvedValue([]),
  primaryWindowId: vi.fn().mockReturnValue('w1'),
  attachPhoneObserver: vi.fn().mockImplementation(() => ({
    cursor: 7,
    dropped: false,
    cols: 80,
    rows: 24,
    detach: vi.fn(),
  })),
  ptyResize: vi.fn(),
  ptyWrite: vi.fn(),
  listAsks: vi.fn().mockReturnValue([]),
  answerAsk: vi.fn().mockReturnValue('unknown-ask'),
  agentRunning: vi.fn().mockReturnValue(false),
} satisfies GatewayControlDeps

const clients: Client[] = []

async function connect(token: string): Promise<Client> {
  const ws = new WebSocket(`wss://127.0.0.1:${port}/ws`, { rejectUnauthorized: false })
  const json: Json[] = []
  const waiters: Array<{ pred: (m: Json) => boolean; resolve: (m: Json) => void }> = []
  ws.on('message', (data, isBinary) => {
    if (isBinary) return
    const msg = JSON.parse(data.toString()) as Json
    json.push(msg)
    for (const w of [...waiters]) {
      if (w.pred(msg)) {
        waiters.splice(waiters.indexOf(w), 1)
        w.resolve(msg)
      }
    }
  })
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)))
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  const next = (pred: (m: Json) => boolean): Promise<Json> => {
    const found = json.find(pred)
    if (found) return Promise.resolve(found)
    return new Promise((resolve) => waiters.push({ pred, resolve }))
  }
  const call = (method: string, params?: unknown): Promise<Json> => {
    const id = ++seq
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    return next((m) => m.id === id)
  }
  const client = { ws, json, closed, next, call }
  clients.push(client)
  await call('hello', { deviceToken: token })
  return client
}

function binary(type: number, payload: string): Buffer {
  return Buffer.concat([Buffer.from([type]), Buffer.from(payload, 'utf8')])
}

describe('gateway server over a real WebSocket', () => {
  let prevXdg: string | undefined
  let externalPaneId = ''

  beforeAll(async () => {
    prevXdg = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), 'ostia-gateway-xdg-'))
    configureGatewayControl(deps)
    externalPaneId = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'p1' }).externalId
    const started = await startGateway({ port: 0 })
    port = started.port
  }, 30_000)

  afterEach(() => {
    for (const c of clients.splice(0)) c.ws.terminate()
    vi.clearAllMocks()
  })

  afterAll(async () => {
    await stopGateway()
    const xdg = process.env.XDG_DATA_HOME
    if (prevXdg === undefined) Reflect.deleteProperty(process.env, 'XDG_DATA_HOME')
    else process.env.XDG_DATA_HOME = prevXdg
    if (xdg) rmSync(xdg, { recursive: true, force: true })
  })

  it('downgrades an owner attach to observer and drops input frames without the input cap', async () => {
    const { token } = registerDevice({ name: 'Phone', pubkey: 'pk' })
    const c = await connect(token)

    const attach = await c.call('pty.attach', { paneId: externalPaneId, role: 'owner' })
    expect(attach.result).toMatchObject({ cursor: 7, role: 'observer' })

    c.ws.send(binary(0x02, 'rm -rf ~\r'))
    const denied = await c.next((m) => m.error?.code === -32003)
    expect(denied.error?.data).toEqual({ cap: 'input' })

    c.ws.send(binary(0x03, JSON.stringify({ cols: 120, rows: 40 })))
    await c.call('whoami')
    expect(deps.ptyWrite).not.toHaveBeenCalled()
    expect(deps.ptyResize).not.toHaveBeenCalled()
  })

  it('writes input and resizes the pty once the desktop grants input', async () => {
    const { deviceId, token } = registerDevice({ name: 'Phone', pubkey: 'pk' })
    const c = await connect(token)

    expect(gatewaySetCap({ deviceId, cap: 'input', granted: true })).toMatchObject({ ok: true })
    const changed = await c.next((m) => m.params?.type === 'caps.changed')
    expect(changed.params?.payload).toEqual({ caps: ['read', 'notify', 'input'] })
    expect((await c.call('device.caps')).result).toEqual({
      caps: ['read', 'notify', 'input'],
    })

    const attach = await c.call('pty.attach', { paneId: externalPaneId, role: 'owner' })
    expect(attach.result).toMatchObject({ role: 'owner' })

    c.ws.send(binary(0x02, 'ls\r'))
    c.ws.send(binary(0x03, JSON.stringify({ paneId: externalPaneId, cols: 120, rows: 40 })))
    c.ws.send(binary(0x03, JSON.stringify({ cols: 0, rows: 40 })))
    c.ws.send(binary(0x03, JSON.stringify({ paneId: 'someone-else', cols: 50, rows: 10 })))
    await c.call('whoami')

    expect(deps.ptyWrite).toHaveBeenCalledWith('p1', 'ls\r')
    expect(deps.ptyResize).toHaveBeenCalledTimes(1)
    expect(deps.ptyResize).toHaveBeenCalledWith('p1', 120, 40)
  })

  it('never lets the input cap run command.exec', async () => {
    const { deviceId, token } = registerDevice({ name: 'Phone', pubkey: 'pk' })
    gatewaySetCap({ deviceId, cap: 'input', granted: true })
    const c = await connect(token)

    const res = await c.call('command.exec', { id: 'pane.splitRight' })
    expect(res.error).toMatchObject({ code: -32003, data: { cap: 'command' } })
    expect(deps.execCommand).not.toHaveBeenCalled()

    gatewaySetCap({ deviceId, cap: 'command', granted: true })
    const ok = await c.call('command.exec', { id: 'pane.splitRight' })
    expect(ok.result).toEqual({ ok: true, result: null })
    expect(deps.execCommand).toHaveBeenCalledTimes(1)
  })

  it('closes live sockets when a permission is removed so the device reconnects smaller', async () => {
    const { deviceId, token } = registerDevice({ name: 'Phone', pubkey: 'pk' })
    gatewaySetCap({ deviceId, cap: 'input', granted: true })
    const c = await connect(token)
    await c.call('pty.attach', { paneId: externalPaneId, role: 'owner' })

    gatewaySetCap({ deviceId, cap: 'input', granted: false })
    expect(await c.closed).toBe(4004)

    const again = await connect(token)
    const attach = await again.call('pty.attach', { paneId: externalPaneId, role: 'owner' })
    expect(attach.result).toMatchObject({ role: 'observer' })
  })

  it('pushes attention and state events, mapping notify.from to the pane externalId', async () => {
    const { token } = registerDevice({ name: 'Phone', pubkey: 'pk' })
    const c = await connect(token)

    emitPlatformEvent('agent.needs-input', { sessionId: 's1' })
    emitPlatformEvent('session.state', { sessionId: 's1', state: 'waiting' })
    emitPlatformEvent('notify', { title: 'Build done', from: 'p1' })

    const needs = await c.next((m) => m.params?.type === 'agent.needs-input')
    expect(needs.params?.payload).toEqual({ sessionId: 's1' })
    const state = await c.next((m) => m.params?.type === 'session.state')
    expect(state.params?.payload).toEqual({ sessionId: 's1', state: 'waiting' })
    const notify = await c.next((m) => m.params?.type === 'notify')
    expect(notify.params?.payload).toEqual({ title: 'Build done', from: externalPaneId })
  })

  it('sends ask.created and ask.resolved to every phone with read', async () => {
    const first = await connect(registerDevice({ name: 'Phone', pubkey: 'pk' }).token)
    const second = await connect(registerDevice({ name: 'Tablet', pubkey: 'pk2' }).token)
    const ask = {
      askId: 'question-1',
      sessionId: 's1',
      paneId: externalPaneId,
      kind: 'question' as const,
      title: 'Ship it?',
      choices: [],
      allowText: true,
      since: 1,
    }

    emitPlatformEvent('ask.created', { ask })
    emitPlatformEvent('ask.resolved', { askId: 'question-1', outcome: 'answered' })

    for (const c of [first, second]) {
      const created = await c.next((m) => m.params?.type === 'ask.created')
      expect(created.params?.payload).toEqual({ ask })
      const resolved = await c.next((m) => m.params?.type === 'ask.resolved')
      expect(resolved.params?.payload).toEqual({ askId: 'question-1', outcome: 'answered' })
    }
  })

  it('reports a phone that can answer only while one holding respond is connected', async () => {
    const { deviceId, token } = registerDevice({ name: 'Phone', pubkey: 'pk' })
    const c = await connect(token)
    expect(phoneCanRespond()).toBe(false)

    gatewaySetCap({ deviceId, cap: 'respond', granted: true })
    await c.next((m) => m.params?.type === 'caps.changed')
    expect(phoneCanRespond()).toBe(true)

    c.ws.terminate()
    await c.closed
    await vi.waitFor(() => expect(phoneCanRespond()).toBe(false))
  })

  it('exposes no control-socket method that can change device permissions', () => {
    registerGatewayMethods()
    expect(registeredMethods.sort()).toEqual([
      'gateway.devices',
      'gateway.pair',
      'gateway.revoke',
      'gateway.status',
    ])
  })
})
