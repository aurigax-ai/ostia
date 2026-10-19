import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  PhoneScreenEvent,
  PhoneScreenFrameHeader,
  PhoneScreenLink,
} from '@aurigax-ai/ostia-extension-sdk/contract/phoneScreens'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { emitPlatformEvent } from '../control/events'
import { registerPane } from '../control/idRegistry'
import type { GatewayControlDeps } from './controlDispatch'
import { registerDevice, revoke } from './devices'
import { type ScreenLinkController, ScreenLinks } from './screenLinks'

const registeredMethods = vi.hoisted(() => [] as string[])

vi.mock('electron', () => ({
  app: { getPath: () => process.env.XDG_DATA_HOME, getVersion: () => '0.0.0-test' },
  ipcMain: { handle: () => {} },
}))

vi.mock('../control/controlServer', () => ({
  registerControlMethod: (name: string) => registeredMethods.push(name),
}))

const {
  askPhonesForScreen,
  capForPlatformEvent,
  closeDeviceSockets,
  configureGatewayControl,
  configureScreenLinks,
  phoneCanRespond,
  startGateway,
  stopGateway,
} = await import('./server')
const { gatewaySetCap, registerGatewayMethods } = await import('./gatewayIpc')

type Json = {
  id?: unknown
  method?: string
  result?: unknown
  error?: { code: number; message?: string; data?: unknown }
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

const linkLog: Array<[string, Record<string, string>]> = []
const links = new ScreenLinks({
  listWorkspaces: async () => [
    { workspaceId: 's1', name: 'One', kind: 'agent', workDir: '/w', state: 'idle' },
    { workspaceId: 'pad', name: 'Scratch', kind: 'scratch', workDir: '/s', state: 'idle' },
    { workspaceId: 'mgr', name: 'Manager', kind: 'manager', workDir: '/m', state: 'idle' },
  ],
  askPhones: (sessionId) => askPhonesForScreen(sessionId),
  log: (event, fields) => linkLog.push([event, fields]),
  timing: { offerMs: 200, requestMs: 300, graceMs: 100 },
})

interface FakeController {
  controller: ScreenLinkController
  offers: PhoneScreenLink[]
  events: PhoneScreenEvent[]
  frames: Array<{ linkId: string; header: PhoneScreenFrameHeader; jpeg: Buffer }>
}

let controller: FakeController | null = null

function listenForScreens(accept = true): FakeController {
  const fake: FakeController = {
    offers: [],
    events: [],
    frames: [],
    controller: {
      offer: async (link) => {
        fake.offers.push(link)
        return accept
      },
      frame: (linkId, header, jpeg) => fake.frames.push({ linkId, header, jpeg }),
      event: (event) => fake.events.push(event),
    },
  }
  expect(links.listen(fake.controller)).toBe(true)
  controller = fake
  return fake
}

function screenParams(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: 's1',
    width: 1080,
    height: 2400,
    density: 2.75,
    rotation: 0,
    level: 'control',
    limitSec: 300,
    endsAt: Date.now() + 300_000,
    overlayHeight: 96,
    label: 'Check the build page',
    agent: 'claude',
    ...over,
  }
}

function screenFrame(header: Record<string, unknown>, jpeg: Buffer): Buffer {
  const head = Buffer.from(JSON.stringify(header))
  const length = Buffer.alloc(4)
  length.writeUInt32BE(head.length)
  return Buffer.concat([Buffer.from([0x10]), length, head, jpeg])
}
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
  artifactsDir: vi.fn().mockReturnValue(null),
  openArtifact: vi.fn().mockResolvedValue(true),
  fileScope: vi.fn().mockReturnValue({
    home: '/nonexistent-home',
    dataDirs: [],
    rules: { denyRead: [], allowRead: [] },
  }),
  listWorkspaceGroups: vi.fn().mockResolvedValue([]),
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
  watchesTurn: vi.fn().mockResolvedValue(false),
  turnStarted: vi.fn().mockResolvedValue(true),
  paneTurns: { list: vi.fn().mockReturnValue([]), output: vi.fn().mockReturnValue(null) },
  redact: vi.fn(async (text: string) => text),
  remote: vi.fn().mockReturnValue(false),
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
    configureScreenLinks(links)
    externalPaneId = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'p1' }).externalId
    const started = await startGateway({ port: 0 })
    port = started.port
  }, 30_000)

  afterEach(() => {
    for (const c of clients.splice(0)) c.ws.terminate()
    vi.clearAllMocks()
    if (controller) links.release(controller.controller)
    controller = null
    linkLog.length = 0
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

  it('sends artifact.changed to a phone with read', async () => {
    const c = await connect(registerDevice({ name: 'Phone', pubkey: 'pk' }).token)
    expect(capForPlatformEvent('artifact.changed')).toBe('read')
    emitPlatformEvent('artifact.changed', { sessionId: 's1', path: 'report.md', change: 'added' })
    const changed = await c.next((m) => m.params?.type === 'artifact.changed')
    expect(changed.params?.payload).toEqual({
      sessionId: 's1',
      path: 'report.md',
      change: 'added',
    })
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

  describe('phone screen links', () => {
    async function openLink(level = 'control') {
      const device = registerDevice({ name: 'Pixel', pubkey: 'pk' })
      const phone = await connect(device.token)
      const started = await phone.call('screen.start', screenParams({ level }))
      const linkId = (started.result as { screenId: string }).screenId
      return { device, phone, linkId }
    }

    it('PHD-C1 hands a link the phone opened to the controller and answers the phone its screenId', async () => {
      const fake = listenForScreens()
      const { device, linkId } = await openLink()
      expect(typeof linkId).toBe('string')
      expect(fake.offers).toEqual([
        expect.objectContaining({
          linkId,
          sessionId: 's1',
          width: 1080,
          height: 2400,
          level: 'control',
          limitSec: 300,
          overlayHeight: 96,
          label: 'Check the build page',
          agent: 'claude',
          device: { id: device.deviceId, name: 'Pixel' },
        }),
      ])
      expect(linkLog).toEqual([['phone-screen-link', { linkId, state: 'started' }]])
    })

    it('PHD-C2 answers no-controller when no extension takes phone screens and keeps nothing', async () => {
      const device = registerDevice({ name: 'Pixel', pubkey: 'pk' })
      const phone = await connect(device.token)
      const refused = await phone.call('screen.start', screenParams())
      expect(refused.error).toMatchObject({ code: -32004, message: 'no-controller' })

      const declining = listenForScreens(false)
      const declined = await (await connect(device.token)).call('screen.start', screenParams())
      expect(declined.error).toMatchObject({ code: -32004, message: 'no-controller' })
      links.release(declining.controller)

      listenForScreens()
      const started = await (await connect(device.token)).call('screen.start', screenParams())
      expect(started.result).toEqual({ screenId: expect.any(String) })
    })

    it('PHD-C3 refuses a scratch or manager workspace, a second link from the device and a 3600 s limit without an offer', async () => {
      const fake = listenForScreens()
      const device = registerDevice({ name: 'Pixel', pubkey: 'pk' })
      const start = async (params: Record<string, unknown>) =>
        (await connect(device.token)).call('screen.start', params)
      for (const sessionId of ['pad', 'mgr']) {
        const refused = await start(screenParams({ sessionId }))
        expect(refused.error).toMatchObject({ code: -32602, message: 'unknown-session' })
        expect(await links.ask(fake.controller, sessionId)).toEqual({
          ok: false,
          error: 'unknown-session',
        })
      }
      const hour = await start(screenParams({ limitSec: 3600 }))
      expect(hour.error).toMatchObject({ code: -32602, message: 'bad-params' })
      const late = await start(screenParams({ endsAt: Date.now() + 3_600_000 }))
      expect(late.error).toMatchObject({ code: -32602, message: 'bad-params' })
      expect(fake.offers).toEqual([])

      const phone = await connect(device.token)
      await phone.call('screen.start', screenParams())
      const second = await connect(device.token)
      const busy = await second.call('screen.start', screenParams())
      expect(busy.error).toMatchObject({ code: -32602, message: 'busy' })
      expect(fake.offers).toHaveLength(1)
    })

    it('PHD-C1 opens a link only on a socket that never attached a pty and never tried a link before', async () => {
      const fake = listenForScreens()
      const device = registerDevice({ name: 'Pixel', pubkey: 'pk' })
      const viewer = await connect(device.token)
      await viewer.call('pty.attach', { paneId: externalPaneId })
      await viewer.call('pty.detach', { paneId: externalPaneId })
      const afterAttach = await viewer.call('screen.start', screenParams())
      expect(afterAttach.error).toMatchObject({ code: -32602, message: 'busy' })

      const retrying = await connect(device.token)
      const bad = await retrying.call('screen.start', screenParams({ limitSec: 3600 }))
      expect(bad.error).toMatchObject({ message: 'bad-params' })
      const again = await retrying.call('screen.start', screenParams())
      expect(again.error).toMatchObject({ code: -32602, message: 'busy' })
      const attach = await retrying.call('pty.attach', { paneId: externalPaneId })
      expect(attach.error).toMatchObject({ code: -32600, message: 'link-only' })
      expect(deps.attachPhoneObserver).toHaveBeenCalledTimes(1)
      expect(fake.offers).toEqual([])
    })

    it('PHD-C4 answers link-only to pty.attach and command.exec on a link and still lists asks', async () => {
      listenForScreens()
      const { device, phone } = await openLink()
      gatewaySetCap({ deviceId: device.deviceId, cap: 'command', granted: true })

      const attach = await phone.call('pty.attach', { paneId: externalPaneId })
      expect(attach.error).toMatchObject({ code: -32600, message: 'link-only' })
      const exec = await phone.call('command.exec', { id: 'pane.splitRight' })
      expect(exec.error).toMatchObject({ code: -32600, message: 'link-only' })
      expect(deps.attachPhoneObserver).not.toHaveBeenCalled()
      expect(deps.execCommand).not.toHaveBeenCalled()

      const asks = await phone.call('ask.list')
      expect(asks.error).toBeUndefined()
      expect(deps.listAsks).toHaveBeenCalled()
    })

    it('PHD-C5 relays a request to the phone, its answer back, and its events and frames to the controller', async () => {
      const fake = listenForScreens()
      const { phone, linkId } = await openLink()

      const tapped = links.request(fake.controller, linkId, 'phone.tap', { x: 10, y: 20 })
      const request = await phone.next((m) => m.method === 'phone.tap')
      expect(request.params).toEqual({ x: 10, y: 20 })
      phone.ws.send(
        JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { target: { text: 'OK' } } }),
      )
      expect(await tapped).toEqual({ ok: true, data: { target: { text: 'OK' } } })

      const paused = links.request(fake.controller, linkId, 'phone.swipe', {})
      const swipe = await phone.next((m) => m.method === 'phone.swipe')
      phone.ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: swipe.id,
          error: { code: -32010, message: 'paused', data: { reason: 'human-touch' } },
        }),
      )
      expect(await paused).toEqual({ ok: false, error: 'paused', data: { reason: 'human-touch' } })

      const state = { state: 'paused', reason: 'human-touch', width: 1080, height: 2400 }
      phone.ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'event',
          params: { type: 'screen.state', payload: state },
        }),
      )
      const header = { seq: 1, width: 540, height: 1200, screenWidth: 1080, screenHeight: 2400 }
      for (let i = 0; i < 7; i++) {
        phone.ws.send(screenFrame({ ...header, seq: i, blocked: false }, Buffer.from([0xff, i])))
      }
      phone.ws.send(screenFrame({ ...header, blocked: 'no' }, Buffer.from([0xff])))
      await phone.call('ask.list')
      expect(fake.events).toEqual([{ linkId, kind: 'state', payload: state }])
      expect(fake.frames.map((f) => f.header.seq)).toEqual([0, 1, 2, 3, 4])
      expect(fake.frames[2]).toEqual({
        linkId,
        header: { ...header, seq: 2, blocked: false },
        jpeg: Buffer.from([0xff, 2]),
      })
    })

    it('PHD-C6 refuses a method outside the contract, input on a view link and another controller; the phone gets nothing', async () => {
      const fake = listenForScreens()
      const { phone, linkId } = await openLink('view')
      const other: ScreenLinkController = {
        offer: async () => true,
        frame: () => {},
        event: () => {},
      }

      expect(await links.request(fake.controller, linkId, 'pty.write', {})).toEqual({
        ok: false,
        error: 'unknown-method',
      })
      expect(await links.request(fake.controller, linkId, 'phone.tap', { x: 1, y: 1 })).toEqual({
        ok: false,
        error: 'view-only',
      })
      expect(await links.request(other, linkId, 'phone.capture', {})).toEqual({
        ok: false,
        error: 'unknown-link',
      })
      expect(links.listen(other)).toBe(false)
      await phone.call('ask.list')
      expect(phone.json.filter((m) => m.method?.startsWith('phone.'))).toEqual([])
    })

    it('PHD-C7 closes the link 4003 at revocation, answers a waiting request and tells the controller it ended', async () => {
      const fake = listenForScreens()
      const { device, phone, linkId } = await openLink()
      const waiting = links.request(fake.controller, linkId, 'phone.capture', {})
      await phone.next((m) => m.method === 'phone.capture')

      revoke(device.deviceId)
      closeDeviceSockets(device.deviceId)
      expect(await phone.closed).toBe(4003)
      expect(await waiting).toEqual({ ok: false, error: 'link-ended' })
      await vi.waitFor(() =>
        expect(fake.events).toContainEqual({
          linkId,
          kind: 'ended',
          payload: { reason: 'revoked' },
        }),
      )
    })

    it('PHD-C8 closes the link 4005 once endsAt and the grace have passed and the phone stayed', async () => {
      const fake = listenForScreens()
      const device = registerDevice({ name: 'Pixel', pubkey: 'pk' })
      const phone = await connect(device.token)
      const started = await phone.call('screen.start', screenParams({ endsAt: Date.now() + 150 }))
      const linkId = (started.result as { screenId: string }).screenId
      expect(await phone.closed).toBe(4005)
      expect(fake.events).toContainEqual({
        linkId,
        kind: 'ended',
        payload: { reason: 'time-limit' },
      })
    })

    it('PHD-C9 closes the link 4006 when the controller goes', async () => {
      const fake = listenForScreens()
      const { phone, linkId } = await openLink()
      links.release(fake.controller)
      expect(await phone.closed).toBe(4006)
      expect(fake.events).toEqual([{ linkId, kind: 'ended', payload: { reason: 'no-controller' } }])
    })

    it('PHD-C10 logs only the link id and keeps no frame, request or typed text', async () => {
      const fake = listenForScreens()
      const { phone, linkId } = await openLink()
      const typed = links.request(fake.controller, linkId, 'phone.type', { text: 'hunter2-secret' })
      const request = await phone.next((m) => m.method === 'phone.type')
      phone.ws.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }))
      await typed
      const header = {
        seq: 1,
        width: 4,
        height: 4,
        screenWidth: 4,
        screenHeight: 4,
        blocked: false,
      }
      phone.ws.send(screenFrame(header, Buffer.from('jpeg-bytes-of-the-screen')))
      await phone.call('ask.list')
      phone.ws.close()
      await phone.closed
      await vi.waitFor(() => expect(linkLog).toHaveLength(2))

      expect(linkLog).toEqual([
        ['phone-screen-link', { linkId, state: 'started' }],
        ['phone-screen-link', { linkId, state: 'ended', reason: 'closed' }],
      ])
      const dataDir = process.env.XDG_DATA_HOME ?? ''
      const stored = readdirSync(dataDir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf8'))
        .join('\n')
      for (const secret of ['hunter2-secret', 'jpeg-bytes-of-the-screen', 'Check the build page']) {
        expect(stored).not.toContain(secret)
      }
    })

    it('PHD-C11 asks the phones for a session over their normal sockets and opens no link', async () => {
      const fake = listenForScreens()
      const notified = await connect(registerDevice({ name: 'Tablet', pubkey: 'pk2' }).token)
      const { phone } = await openLink()

      expect(await links.ask(fake.controller, 'pad')).toEqual({
        ok: false,
        error: 'unknown-session',
      })
      expect(await links.ask(fake.controller, 's1')).toEqual({ ok: true, data: null })
      const asked = await notified.next((m) => m.params?.type === 'screen.requested')
      expect(asked.params?.payload).toEqual({ sessionId: 's1', by: 'desktop' })
      await phone.call('ask.list')
      expect(phone.json.some((m) => m.params?.type === 'screen.requested')).toBe(false)
      expect(fake.offers).toHaveLength(1)
    })
  })
})
