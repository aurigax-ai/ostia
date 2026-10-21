import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
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
import { get as getDevice, registerDevice, revoke } from './devices'
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
  notifiedDeviceIds,
  closeDeviceSockets,
  configureGatewayControl,
  configureScreenLinks,
  phoneCanRespond,
  setTailnetNode,
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
    { workspaceId: 's2', name: 'Two', kind: 'agent', workDir: '/w2', state: 'idle' },
  ],
  askPhones: (request, deviceIds) => askPhonesForScreen(request, deviceIds),
  log: (event, fields) => linkLog.push([event, fields]),
  timing: { offerMs: 200, requestMs: 300, graceMs: 100 },
  requestTiming: { waitMs: 400, cooldownMs: 300, noAnswerCooldownMs: 0 },
  notifiedDevices: () => notifiedDeviceIds(),
  agentRunning: (paneId) => paneId !== 'plain-shell',
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
  agentStreams: { open: vi.fn() },
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
    hold: vi.fn().mockReturnValue('ok'),
    release: vi.fn(),
    detach: vi.fn(),
  })),
  ptyWrite: vi.fn(),
  readScreen: vi.fn().mockResolvedValue(''),
  withClipboardImage: vi.fn().mockResolvedValue(true),
  listAsks: vi.fn().mockReturnValue([]),
  answerAsk: vi.fn().mockReturnValue('unknown-ask'),
  agentRunning: vi.fn().mockReturnValue(false),
  watchesTurn: vi.fn().mockResolvedValue(false),
  turnStarted: vi.fn().mockResolvedValue(true),
  paneSince: vi.fn().mockReturnValue(undefined),
  paneTurns: { list: vi.fn().mockReturnValue([]), output: vi.fn().mockReturnValue(null) },
  redact: vi.fn(async (text: string) => text),
  ownSnippets: vi.fn().mockReturnValue([]),
  remote: vi.fn().mockReturnValue(false),
  startAgent: vi.fn().mockResolvedValue(null),
  phoneWorkspace: vi.fn().mockResolvedValue(null),
  phoneDefaults: vi.fn().mockReturnValue({ set: false, agent: 'claude' }),
  isPhoneWorkspace: vi.fn().mockReturnValue(false),
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

  it('PHW-C8 hello says the Phone workspace is set only as the refusal-aware defaults do', async () => {
    deps.phoneDefaults.mockReturnValueOnce({ set: false, agent: 'codex' })
    const { token } = registerDevice({ name: 'Phone', pubkey: 'pk' })
    const c = await connect(token)
    expect(c.json[0]?.result).toMatchObject({ phoneWorkspace: { set: false, agent: 'codex' } })
    expect(deps.phoneDefaults).toHaveBeenCalledTimes(1)
  })

  describe('addresses a paired phone can reach this computer on', () => {
    const NODE = { ip: '100.101.102.103', dnsName: 'ostia-box.tail1234.ts.net' }
    const nodeAddresses = () => [
      { kind: 'tailnet', host: NODE.dnsName, port },
      { kind: 'tailnet', host: NODE.ip, port },
    ]

    afterEach(() => setTailnetNode(null))

    function upgradeStatus(host: string): Promise<number> {
      return new Promise((resolve) => {
        const ws = new WebSocket(`wss://127.0.0.1:${port}/ws`, {
          rejectUnauthorized: false,
          headers: { Host: host },
        })
        ws.once('open', () => {
          ws.terminate()
          resolve(101)
        })
        ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
        ws.once('error', () => resolve(0))
      })
    }

    it('PID-C13 hello updates the device name to the one the phone sends now', async () => {
      const { deviceId, token } = registerDevice({ name: 'Phone', pubkey: 'pk' })
      const c = await connect(token)
      await c.call('hello', { deviceToken: token, name: 'Desk phone' })
      expect(getDevice(deviceId)?.name).toBe('Desk phone')
      await c.call('hello', { deviceToken: token, name: 'bad\u202Ename' })
      expect(getDevice(deviceId)?.name).toBe('Desk phone')
      await c.call('hello', { deviceToken: token })
      expect(getDevice(deviceId)?.name).toBe('Desk phone')
    })

    it('RDS-C29 hello lists the current addresses, best first', async () => {
      setTailnetNode(NODE)
      const { token } = registerDevice({ name: 'Phone', pubkey: 'pk' })
      const c = await connect(token)
      expect(c.json[0]?.result).toMatchObject({ addresses: nodeAddresses() })
    })

    it('RDS-C30 hello lists nothing on a loopback bind with no tunnel', async () => {
      const { token } = registerDevice({ name: 'Phone', pubkey: 'pk' })
      const c = await connect(token)
      expect(c.json[0]?.result).toMatchObject({ addresses: [] })
    })

    it('RDS-C31 tells live sockets when the list changes, and not when it stays', async () => {
      const { token } = registerDevice({ name: 'Phone', pubkey: 'pk' })
      const c = await connect(token)
      setTailnetNode(NODE)
      const event = await c.next((m) => m.params?.type === 'addresses.changed')
      expect(event.params?.payload).toEqual({ addresses: nodeAddresses() })
      const seen = c.json.length
      setTailnetNode({ ...NODE })
      await c.call('device.caps')
      expect(c.json.slice(seen).filter((m) => m.params?.type === 'addresses.changed')).toEqual([])
    })

    it('RDS-C32 sends the list to no socket that has not passed hello', async () => {
      const ws = new WebSocket(`wss://127.0.0.1:${port}/ws`, { rejectUnauthorized: false })
      const received: string[] = []
      ws.on('message', (data) => received.push(data.toString()))
      await new Promise<void>((resolve) => ws.once('open', () => resolve()))
      setTailnetNode(NODE)
      await new Promise((resolve) => setTimeout(resolve, 50))
      ws.terminate()
      expect(received).toEqual([])
    })

    it('RDS-C33 accepts the MagicDNS name as Host with or without the port', async () => {
      setTailnetNode(NODE)
      expect(await upgradeStatus(`${NODE.dnsName}:${port}`)).toBe(101)
      expect(await upgradeStatus(NODE.dnsName)).toBe(101)
    })

    it('RDS-C34 refuses a name or address the gateway no longer has', async () => {
      setTailnetNode(NODE)
      setTailnetNode({ ip: '100.101.102.200', dnsName: 'ostia-new.tail1234.ts.net' })
      expect(await upgradeStatus(`${NODE.dnsName}:${port}`)).toBe(401)
      expect(await upgradeStatus(`${NODE.ip}:${port}`)).toBe(401)
      expect(await upgradeStatus('ostia-new.tail1234.ts.net')).toBe(101)
    })
  })

  it('downgrades an owner attach to observer and drops input frames without the input cap', async () => {
    const { token } = registerDevice({ name: 'Phone', pubkey: 'pk' })
    const c = await connect(token)

    const attach = await c.call('pty.attach', { paneId: externalPaneId, role: 'owner' })
    expect(attach.result).toMatchObject({ cursor: 7, cols: 80, rows: 24, role: 'observer' })

    c.ws.send(binary(0x02, 'rm -rf ~\r'))
    const denied = await c.next((m) => m.error?.code === -32003)
    expect(denied.error?.data).toEqual({ cap: 'input' })
    expect(deps.ptyWrite).not.toHaveBeenCalled()
  })

  it('writes input once the desktop grants input', async () => {
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
    await c.call('whoami')

    expect(deps.ptyWrite).toHaveBeenCalledWith('p1', 'ls\r', 'key')
  })

  it('never applies a resize frame and answers resize-not-supported', async () => {
    const { deviceId, token } = registerDevice({ name: 'Phone', pubkey: 'pk' })
    gatewaySetCap({ deviceId, cap: 'input', granted: true })
    const owner = await connect(token)
    await owner.call('pty.attach', { paneId: externalPaneId, role: 'owner' })

    owner.ws.send(binary(0x03, JSON.stringify({ paneId: externalPaneId, cols: 120, rows: 40 })))
    const refused = await owner.next((m) => m.error?.message === 'resize-not-supported')
    expect(refused.error?.code).toBe(-32602)

    const observer = await connect(token)
    await observer.call('pty.attach', { paneId: externalPaneId })
    observer.ws.send(binary(0x03, JSON.stringify({ cols: 120, rows: 40 })))
    const observerRefused = await observer.next((m) => m.error?.message === 'resize-not-supported')
    expect(observerRefused.error?.code).toBe(-32602)
    expect(deps.ptyWrite).not.toHaveBeenCalled()
  })

  it('answers resize-not-supported to a resize frame from a socket that never attached', async () => {
    const { token } = registerDevice({ name: 'Phone', pubkey: 'pk' })
    const c = await connect(token)

    c.ws.send(binary(0x03, JSON.stringify({ cols: 120, rows: 40 })))
    const refused = await c.next((m) => m.error?.message === 'resize-not-supported')
    expect(refused.error?.code).toBe(-32602)
    expect(deps.attachPhoneObserver).not.toHaveBeenCalled()
    expect(deps.ptyWrite).not.toHaveBeenCalled()
  })

  describe('agent stream', () => {
    const owned = [{ workspaceId: 's1', name: 'One', kind: 'agent', workDir: '/w', state: 'idle' }]

    function stream() {
      let send: (events: unknown[], backfill: boolean) => void = () => undefined
      const close = vi.fn()
      deps.agentStreams.open.mockResolvedValueOnce({
        agent: 'claude',
        session: 'sess-1',
        truncated: false,
        start: (fn: typeof send) => {
          send = fn
        },
        close,
      })
      return { push: (events: unknown[], backfill = false) => send(events, backfill), close }
    }

    it('streams the backfill and then live events to a phone with the read cap', async () => {
      deps.listWorkspaces.mockResolvedValueOnce(owned)
      const s = stream()
      const { token } = registerDevice({ name: 'Phone', pubkey: 'pk' })
      const c = await connect(token)
      const opened = await c.call('agent.stream.open', { paneId: externalPaneId, turns: 2 })
      expect(opened.result).toEqual({
        ok: true,
        paneId: externalPaneId,
        agent: 'claude',
        session: 'sess-1',
        truncated: false,
      })
      s.push([{ type: 'turn.started', turn: 'u1' }, { type: 'live' }], true)
      s.push([{ type: 'text', turn: 'u1', id: 'a', text: 'hello' }])
      const live = await c.next(
        (m) => m.params?.type === 'agent.stream' && (m.params.payload as { seq: number }).seq === 2,
      )
      expect(live.params?.payload).toEqual({
        paneId: externalPaneId,
        seq: 2,
        events: [{ type: 'text', turn: 'u1', id: 'a', text: 'hello' }],
      })
      const first = c.json.find(
        (m) => m.params?.type === 'agent.stream' && (m.params.payload as { seq: number }).seq === 1,
      )
      expect(first?.params?.payload).toMatchObject({ backfill: true })
    })

    it('refuses a pane outside what session.list shows', async () => {
      const { token } = registerDevice({ name: 'Phone', pubkey: 'pk' })
      const c = await connect(token)
      const refused = await c.call('agent.stream.open', { paneId: externalPaneId })
      expect(refused.error).toMatchObject({ code: -32602, message: 'unknown-pane' })
      expect(deps.agentStreams.open).not.toHaveBeenCalled()
    })

    it('stops the stream on agent.stream.close and when the socket closes', async () => {
      deps.listWorkspaces.mockResolvedValueOnce(owned).mockResolvedValueOnce(owned)
      const first = stream()
      const { token } = registerDevice({ name: 'Phone', pubkey: 'pk' })
      const c = await connect(token)
      await c.call('agent.stream.open', { paneId: externalPaneId })
      expect((await c.call('agent.stream.close', { paneId: externalPaneId })).result).toEqual({
        ok: true,
      })
      expect(first.close).toHaveBeenCalledTimes(1)

      const second = stream()
      await c.call('agent.stream.open', { paneId: externalPaneId })
      c.ws.close()
      await vi.waitFor(() => expect(second.close).toHaveBeenCalledTimes(1))
    })
  })

  describe('size hold', () => {
    async function holder(grant = true) {
      const { deviceId, token } = registerDevice({ name: 'Phone', pubkey: 'pk' })
      if (grant) gatewaySetCap({ deviceId, cap: 'input', granted: true })
      const c = await connect(token)
      return { c, deviceId }
    }
    const lastAttachment = () => vi.mocked(deps.attachPhoneObserver).mock.results.at(-1)?.value

    it('holds the pane at the phone grid for the device attached to it', async () => {
      const { c } = await holder()
      await c.call('pty.attach', { paneId: externalPaneId, role: 'owner' })
      const held = await c.call('pty.hold', { paneId: externalPaneId, cols: 44, rows: 20 })
      expect(held.result).toEqual({ ok: true, cols: 44, rows: 20 })
      expect(lastAttachment().hold).toHaveBeenCalledWith(44, 20)
    })

    it('releases the hold on request', async () => {
      const { c } = await holder()
      await c.call('pty.attach', { paneId: externalPaneId, role: 'owner' })
      await c.call('pty.hold', { paneId: externalPaneId, cols: 44, rows: 20 })
      const released = await c.call('pty.release', { paneId: externalPaneId })
      expect(released.result).toEqual({ ok: true })
      expect(lastAttachment().release).toHaveBeenCalledTimes(1)
    })

    it('refuses a device without the input cap', async () => {
      const { c } = await holder(false)
      await c.call('pty.attach', { paneId: externalPaneId })
      const refused = await c.call('pty.hold', { paneId: externalPaneId, cols: 44, rows: 20 })
      expect(refused.error).toMatchObject({ code: -32003, data: { cap: 'input' } })
      expect(lastAttachment().hold).not.toHaveBeenCalled()
    })

    it('refuses a hold from a socket that is not attached to that pane', async () => {
      const { c } = await holder()
      const unattached = await c.call('pty.hold', { paneId: externalPaneId, cols: 44, rows: 20 })
      expect(unattached.error).toMatchObject({ code: -32602, message: 'not-attached' })
      await c.call('pty.attach', { paneId: externalPaneId, role: 'owner' })
      const other = await c.call('pty.hold', { paneId: 'unknown-pane', cols: 44, rows: 20 })
      expect(other.error).toMatchObject({ code: -32602, message: 'not-attached' })
      expect(lastAttachment().hold).not.toHaveBeenCalled()
    })

    it('refuses a hold from an observer attachment, even with the input cap', async () => {
      const { c } = await holder()
      await c.call('pty.attach', { paneId: externalPaneId })
      const refused = await c.call('pty.hold', { paneId: externalPaneId, cols: 44, rows: 20 })
      expect(refused.error).toMatchObject({ code: -32602, message: 'not-owner' })
      expect((await c.call('pty.release', { paneId: externalPaneId })).error).toMatchObject({
        message: 'not-owner',
      })
      expect(lastAttachment().hold).not.toHaveBeenCalled()
    })

    it('refuses a grid outside 1 to 1000', async () => {
      const { c } = await holder()
      await c.call('pty.attach', { paneId: externalPaneId, role: 'owner' })
      for (const grid of [
        { cols: 0, rows: 20 },
        { cols: 44, rows: 1001 },
        { cols: 4.5, rows: 20 },
        { cols: '44', rows: 20 },
        {},
      ]) {
        const refused = await c.call('pty.hold', { paneId: externalPaneId, ...grid })
        expect(refused.error).toMatchObject({ code: -32602, message: 'bad-size' })
      }
      expect(lastAttachment().hold).not.toHaveBeenCalled()
    })

    it('answers held-by-other when another phone holds the pane', async () => {
      const { c } = await holder()
      await c.call('pty.attach', { paneId: externalPaneId, role: 'owner' })
      lastAttachment().hold.mockReturnValueOnce('held-by-other')
      const refused = await c.call('pty.hold', { paneId: externalPaneId, cols: 44, rows: 20 })
      expect(refused.error).toMatchObject({ code: -32602, message: 'held-by-other' })
    })

    it('gives the size back when the socket closes', async () => {
      const { c } = await holder()
      await c.call('pty.attach', { paneId: externalPaneId, role: 'owner' })
      await c.call('pty.hold', { paneId: externalPaneId, cols: 44, rows: 20 })
      const attachment = lastAttachment()
      c.ws.close()
      await vi.waitFor(() => expect(attachment.detach).toHaveBeenCalledTimes(1))
    })

    it('gives the size back and stops the stream the moment the device is revoked, not when the socket finishes closing', async () => {
      const { c, deviceId } = await holder()
      deps.listWorkspaces.mockResolvedValueOnce([
        { workspaceId: 's1', name: 'One', kind: 'agent', workDir: '/w', state: 'idle' },
      ])
      const streamClose = vi.fn()
      deps.agentStreams.open.mockResolvedValueOnce({
        agent: 'claude',
        session: 's',
        truncated: false,
        start: () => undefined,
        close: streamClose,
      })
      await c.call('pty.attach', { paneId: externalPaneId, role: 'owner' })
      await c.call('pty.hold', { paneId: externalPaneId, cols: 44, rows: 20 })
      await c.call('agent.stream.open', { paneId: externalPaneId })
      const attachment = lastAttachment()
      closeDeviceSockets(deviceId)
      expect(attachment.detach).toHaveBeenCalledTimes(1)
      expect(streamClose).toHaveBeenCalledTimes(1)
    })

    it('gives the size back when the desktop revokes the input cap', async () => {
      const { c, deviceId } = await holder()
      await c.call('pty.attach', { paneId: externalPaneId, role: 'owner' })
      await c.call('pty.hold', { paneId: externalPaneId, cols: 44, rows: 20 })
      const attachment = lastAttachment()
      gatewaySetCap({ deviceId, cap: 'input', granted: false })
      await vi.waitFor(() => expect(attachment.detach).toHaveBeenCalledTimes(1))
    })

    it('still refuses the 0x03 resize frame while it holds the pane', async () => {
      const { c } = await holder()
      await c.call('pty.attach', { paneId: externalPaneId, role: 'owner' })
      await c.call('pty.hold', { paneId: externalPaneId, cols: 44, rows: 20 })
      c.ws.send(binary(0x03, JSON.stringify({ paneId: externalPaneId, cols: 120, rows: 40 })))
      const refused = await c.next((m) => m.error?.message === 'resize-not-supported')
      expect(refused.error?.code).toBe(-32602)
      expect(lastAttachment().hold).toHaveBeenCalledTimes(1)
    })
  })

  it('tells every attached phone the size when the desktop resizes the pane', async () => {
    const { deviceId, token } = registerDevice({ name: 'Phone', pubkey: 'pk' })
    gatewaySetCap({ deviceId, cap: 'input', granted: true })
    const owner = await connect(token)
    await owner.call('pty.attach', { paneId: externalPaneId, role: 'owner' })
    const observer = await connect(token)
    await observer.call('pty.attach', { paneId: externalPaneId })

    for (const [, opts] of vi.mocked(deps.attachPhoneObserver).mock.calls) opts.sendSize(100, 30)

    for (const phone of [owner, observer]) {
      const size = await phone.next((m) => m.params?.type === 'pty.size')
      expect(size.params?.payload).toEqual({ paneId: externalPaneId, cols: 100, rows: 30 })
    }
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

  describe('frame size', () => {
    const overOneMiB = 'a'.repeat(1024 * 1024 + 1)
    const tooBigCloses = process.platform === 'darwin' ? [1009, 1006] : [1009]
    const imageSized = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(2 * 1024 * 1024),
    ]).toString('base64')

    function prompt(call: (method: string, params?: unknown) => Promise<Json>, text: string) {
      return call('agent.prompt', {
        paneId: externalPaneId,
        text: 'look',
        image: { mime: 'image/png', data: text },
      })
    }

    it('closes a frame over 1 MiB sent before hello with nothing dispatched', async () => {
      const ws = new WebSocket(`wss://127.0.0.1:${port}/ws`, { rejectUnauthorized: false })
      const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)))
      ws.on('error', () => {})
      await new Promise<void>((resolve) => ws.once('open', () => resolve()))
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'agent.prompt',
          params: { pad: overOneMiB },
        }),
      )
      expect(tooBigCloses).toContain(await closed)
      expect(deps.ptyWrite).not.toHaveBeenCalled()
      expect(deps.withClipboardImage).not.toHaveBeenCalled()
    })

    it('lets a device holding respond send an image-sized agent.prompt after hello', async () => {
      const { deviceId, token } = registerDevice({ name: 'Phone', pubkey: 'pk' })
      gatewaySetCap({ deviceId, cap: 'respond', granted: true })
      const c = await connect(token)
      expect(c.json[0]?.result).toMatchObject({ features: ['prompt-image'] })
      const answer = await prompt(c.call, imageSized)
      expect(answer.error?.message).not.toBe('image-too-large')
      expect(c.ws.readyState).toBe(WebSocket.OPEN)
    })

    it('holds a device without respond to 1 MiB', async () => {
      const { token } = registerDevice({ name: 'Phone', pubkey: 'pk' })
      const c = await connect(token)
      c.ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 99,
          method: 'agent.prompt',
          params: { pad: overOneMiB },
        }),
      )
      expect(tooBigCloses).toContain(await c.closed)
    })
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

    describe('an agent asking the phone', () => {
      const askerPane = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'asker' })
      const otherAsker = registerPane({ windowId: 'w1', workspaceId: 's2', paneId: 'asker-2' })
      const shellPane = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'plain-shell' })
      const otherPane = registerPane({ windowId: 'w1', workspaceId: 'pad', paneId: 'elsewhere' })
      const asking = (fake: FakeController, over: Record<string, unknown> = {}) =>
        links.askFor(fake.controller, {
          sessionId: 's1',
          pane: askerPane.externalId,
          reason: 'check the app login screen',
          agent: 'claude',
          ...over,
        })
      const requestOf = async (phone: Client, after?: string) => {
        const requested = await phone.next(
          (m) =>
            m.params?.type === 'screen.requested' &&
            (m.params.payload as { requestId?: string }).requestId !== after,
        )
        return requested.params?.payload as Record<string, string>
      }

      it('PHA-C1 sends the agent request with its reason and ends it when the phone starts a session for it', async () => {
        const fake = listenForScreens()
        const device = registerDevice({ name: 'Pixel', pubkey: 'pk' })
        const phone = await connect(device.token)
        const answer = asking(fake)
        const payload = await requestOf(phone)
        expect(payload).toEqual({
          sessionId: 's1',
          by: 'agent',
          reason: 'check the app login screen',
          agent: 'claude',
          pane: askerPane.externalId,
          requestId: expect.any(String),
        })
        const linkSocket = await connect(device.token)
        await linkSocket.call('screen.start', screenParams({ requestId: payload.requestId }))
        expect(await answer).toEqual({ ok: true, data: { outcome: 'started' } })
      })

      it('PHA-C2 declines only when every asked phone declined, and refuses an unknown request', async () => {
        const fake = listenForScreens()
        const first = await connect(registerDevice({ name: 'Pixel', pubkey: 'pk' }).token)
        const second = await connect(registerDevice({ name: 'Tablet', pubkey: 'pk2' }).token)
        const answer = asking(fake)
        const { requestId } = await requestOf(first)
        await requestOf(second)
        const unknown = await first.call('screen.decline', { requestId: 'nope', reason: 'off' })
        expect(unknown.error).toMatchObject({ code: -32602, message: 'unknown-request' })
        const odd = await first.call('screen.decline', { requestId, reason: 'later' })
        expect(odd.error).toMatchObject({ code: -32602, message: 'bad-params' })
        expect((await first.call('screen.decline', { requestId, reason: 'off' })).result).toEqual(
          {},
        )
        let settled = false
        void answer.then(() => {
          settled = true
        })
        await second.call('whoami')
        expect(settled).toBe(false)
        expect(
          (await second.call('screen.decline', { requestId, reason: 'denied' })).result,
        ).toEqual({})
        expect(await answer).toEqual({ ok: true, data: { outcome: 'declined', reason: 'denied' } })
        expect(await asking(fake)).toEqual({ ok: false, error: 'cooldown' })
        await new Promise((resolve) => setTimeout(resolve, 320))
        const again = asking(fake)
        const repeat = await requestOf(first, requestId)
        await first.call('screen.decline', { requestId: repeat.requestId, reason: 'off' })
        await second.call('screen.decline', { requestId: repeat.requestId, reason: 'off' })
        expect(await again).toMatchObject({ data: { outcome: 'declined', reason: 'off' } })
      })

      it('PHA-C16 ends the wait for a phone that disconnects or is revoked', async () => {
        await new Promise((resolve) => setTimeout(resolve, 320))
        const fake = listenForScreens()
        const first = await connect(registerDevice({ name: 'Pixel', pubkey: 'pk' }).token)
        const tablet = registerDevice({ name: 'Tablet', pubkey: 'pk2' })
        const second = await connect(tablet.token)
        const gone = asking(fake)
        const { requestId } = await requestOf(first)
        await first.call('screen.decline', { requestId, reason: 'off' })
        second.ws.close()
        expect(await gone).toEqual({ ok: true, data: { outcome: 'declined', reason: 'off' } })
        await new Promise((resolve) => setTimeout(resolve, 320))
        await connect(tablet.token)
        const revoked = asking(fake)
        const repeat = await requestOf(first, requestId)
        await first.call('screen.decline', { requestId: repeat.requestId, reason: 'denied' })
        closeDeviceSockets(tablet.deviceId)
        expect(await revoked).toEqual({ ok: true, data: { outcome: 'declined', reason: 'denied' } })
      })

      it('PHA-C3 answers no-answer when nobody decides, and holds one waiting request per phone', async () => {
        await new Promise((resolve) => setTimeout(resolve, 320))
        const fake = listenForScreens()
        await connect(registerDevice({ name: 'Pixel', pubkey: 'pk' }).token)
        const first = asking(fake)
        expect(await asking(fake)).toEqual({ ok: false, error: 'busy' })
        expect(await asking(fake, { sessionId: 's2', pane: otherAsker.externalId })).toEqual({
          ok: false,
          error: 'busy',
        })
        expect(await first).toEqual({ ok: true, data: { outcome: 'no-answer' } })
      })

      it('PHA-C4 refuses a pane of another workspace, a pane without an agent, a missing or long reason and a stranger', async () => {
        const fake = listenForScreens()
        await connect(registerDevice({ name: 'Pixel', pubkey: 'pk' }).token)
        const stranger: ScreenLinkController = {
          offer: async () => true,
          frame: () => {},
          event: () => {},
        }
        expect(await asking(fake, { pane: otherPane.externalId })).toEqual({
          ok: false,
          error: 'unknown-pane',
        })
        expect(await asking(fake, { pane: shellPane.externalId })).toEqual({
          ok: false,
          error: 'not-an-agent',
        })
        expect(await asking(fake, { reason: '  ' })).toEqual({ ok: false, error: 'invalid-reason' })
        expect(await asking(fake, { reason: 'x'.repeat(301) })).toEqual({
          ok: false,
          error: 'invalid-reason',
        })
        expect(await asking(fake, { sessionId: 'pad', pane: otherPane.externalId })).toEqual({
          ok: false,
          error: 'unknown-session',
        })
        expect(await links.askFor(stranger, { sessionId: 's1' })).toEqual({
          ok: false,
          error: 'not-listening',
        })
      })

      it('PHA-C9 never ends a request with a link opened for another workspace', async () => {
        const fake = listenForScreens()
        const device = registerDevice({ name: 'Pixel', pubkey: 'pk' })
        const phone = await connect(device.token)
        const answer = asking(fake)
        const { requestId } = await requestOf(phone)
        const wrong = await connect(device.token)
        await wrong.call('screen.start', screenParams({ sessionId: 's2', requestId }))
        expect(await answer).toEqual({ ok: true, data: { outcome: 'no-answer' } })
      })
    })
  })
})
