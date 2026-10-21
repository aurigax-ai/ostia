import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { type AccountHarness, signedIn } from '../../../test/fixtures/server/accountHarness'
import { pushDepsStub } from '../../../test/fixtures/server/pushDepsStub'

vi.mock('electron', () => ({
  app: { getPath: () => process.env.XDG_DATA_HOME, getVersion: () => '0.0.0-test' },
  ipcMain: { handle: () => {} },
}))

const { emitPlatformEvent } = await import('../control/events')
const { get, list, registerDevice, setDevicePush } = await import('./devices')
const { PhonePush } = await import('./phonePush')
const {
  configureGatewayControl,
  configurePhonePush,
  deviceConnected,
  sendDeviceConfig,
  startGateway,
  stopGateway,
} = await import('./server')

interface Frame {
  id?: number
  result?: Record<string, unknown>
  error?: { code: number; message: string }
  params?: { type: string; payload: Record<string, unknown> }
}

class Phone {
  readonly events: Frame[] = []
  private readonly replies = new Map<number, (frame: Frame) => void>()
  private nextId = 1

  constructor(readonly ws: WebSocket) {
    ws.on('message', (data, isBinary) => {
      if (isBinary) return
      const frame = JSON.parse(data.toString()) as Frame
      if (frame.id !== undefined) this.replies.get(frame.id)?.(frame)
      else this.events.push(frame)
    })
  }

  call(method: string, params: Record<string, unknown> = {}): Promise<Frame> {
    const id = this.nextId++
    return new Promise((resolve) => {
      this.replies.set(id, resolve)
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }

  configs(): Array<Record<string, unknown>> {
    return this.events
      .filter((e) => e.params?.type === 'push.config')
      .map((e) => e.params?.payload ?? {})
  }
}

let port = 0
let harness: AccountHarness
let push: InstanceType<typeof PhonePush>
let prevXdg: string | undefined

const deps = {
  agentStreams: { open: vi.fn() },
  execCommand: vi.fn(),
  listCommandsFor: vi.fn().mockReturnValue([]),
  getTerminalState: vi.fn(),
  listPanes: vi.fn().mockResolvedValue([]),
  listWorkspaces: vi.fn().mockResolvedValue([]),
  listWorkspaceGroups: vi.fn().mockResolvedValue([]),
  artifactsDir: vi.fn().mockReturnValue(null),
  openArtifact: vi.fn().mockResolvedValue(true),
  fileScope: vi.fn(),
  primaryWindowId: vi.fn().mockReturnValue('w1'),
  attachPhoneObserver: vi.fn(),
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
}

async function connectPhone(token: string): Promise<{ phone: Phone; hello: Frame }> {
  const ws = new WebSocket(`wss://127.0.0.1:${port}/ws`, { rejectUnauthorized: false })
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  const phone = new Phone(ws)
  const hello = await phone.call('hello', { deviceToken: token })
  return { phone, hello }
}

async function phoneRegistersAtServer(ticket: string): Promise<string> {
  const res = await fetch(`${harness.server.url}/v1/push/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: 'fcm', token: 'fcm-token', ticket }),
  })
  return ((await res.json()) as { handle: string }).handle
}

beforeAll(async () => {
  prevXdg = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), 'ostia-gateway-push-socket-'))
  harness = await signedIn({ push: true, sessionTtlMs: 24 * 3_600_000 })
  push = new PhonePush({
    account: harness.account,
    devices: { list, get, setPush: setDevicePush },
    connected: deviceConnected,
    sendConfig: sendDeviceConfig,
    changed: () => {},
  })
  push.start()
  await push.refreshOffer()
  configurePhonePush(push)
  configureGatewayControl({
    ...deps,
    ...pushDepsStub(),
    sessionWaitingSince: (sessionId: string) => (sessionId === 'ws-1' ? 1234 : undefined),
    push,
  } as never)
  const started = await startGateway({ host: '127.0.0.1', port: 0, tailnet: false })
  port = started.port
}, 30_000)

afterAll(async () => {
  push.stop()
  await stopGateway()
  await harness.close()
  const xdg = process.env.XDG_DATA_HOME
  if (prevXdg === undefined) Reflect.deleteProperty(process.env, 'XDG_DATA_HOME')
  else process.env.XDG_DATA_HOME = prevXdg
  if (xdg) rmSync(xdg, { recursive: true, force: true })
})

describe('push over the gateway socket', () => {
  it('PSH-C42 walks a phone through hello, ticket, register and unregister, with push.config on each switch', async () => {
    const { deviceId, token } = registerDevice({ name: 'Pixel', pubkey: 'pk-push' })
    const first = await connectPhone(token)
    expect(first.hello.result?.push).toBeUndefined()
    expect((await first.phone.call('push.ticket')).error).toMatchObject({
      code: -32602,
      message: 'push-off',
    })

    expect(await push.setEnabled(deviceId, true)).toEqual({ ok: true })
    await vi.waitFor(() =>
      expect(first.phone.configs()).toEqual([{ server: harness.server.url, registered: false }]),
    )

    const ticket = await first.phone.call('push.ticket')
    const handle = await phoneRegistersAtServer(String(ticket.result?.ticket))
    expect(typeof ticket.result?.expiresAt).toBe('number')
    expect(await first.phone.call('push.register', { handle, platform: 'fcm' })).toMatchObject({
      result: { ok: true },
    })
    first.phone.ws.terminate()
    await vi.waitFor(() => expect(deviceConnected(deviceId)).toBe(false))

    const second = await connectPhone(token)
    expect(second.hello.result?.push).toEqual({ server: harness.server.url, registered: true })
    expect(await second.phone.call('push.unregister')).toMatchObject({ result: { ok: true } })
    await vi.waitFor(() => expect(harness.server.push.deleted).toEqual([handle]))
    expect(await second.phone.call('push.unregister')).toMatchObject({ result: { ok: true } })

    expect(await push.setEnabled(deviceId, false)).toEqual({ ok: true })
    await vi.waitFor(() => expect(second.phone.configs().at(-1)).toEqual({ server: null }))
    expect(
      (await second.phone.call('push.register', { handle, platform: 'fcm' })).error,
    ).toMatchObject({ code: -32602, message: 'push-off' })
    second.phone.ws.terminate()
  })

  it('PSH-C43 pings only while the phone has no live socket, and only for something that needs the human', async () => {
    const { deviceId, token } = registerDevice({ name: 'Pixel 2', pubkey: 'pk-push-2' })
    await push.setEnabled(deviceId, true)
    const { phone } = await connectPhone(token)
    const ticket = await phone.call('push.ticket')
    const handle = await phoneRegistersAtServer(String(ticket.result?.ticket))
    await phone.call('push.register', { handle, platform: 'fcm' })

    harness.server.push.pings.length = 0
    emitPlatformEvent('notify', { title: 'secret title', body: 'secret body', from: 'p1' })
    emitPlatformEvent('agent.needs-input', { sessionId: 'ws-1' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(harness.server.push.pings).toEqual([])

    phone.ws.terminate()
    await vi.waitFor(() => expect(deviceConnected(deviceId)).toBe(false))
    emitPlatformEvent('agent.done', { sessionId: 'ws-1' })
    emitPlatformEvent('session.state', { sessionId: 'ws-1', state: 'done' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(harness.server.push.pings).toEqual([])

    emitPlatformEvent('notify', { title: 'secret title', body: 'secret body', from: 'p1' })
    await vi.waitFor(() => expect(harness.server.push.pings).toHaveLength(1))
    expect(harness.server.push.pings[0]).toMatchObject({ handle, contentType: undefined })
    expect(JSON.stringify(harness.server.requests)).not.toContain('secret')
  })

  it('PSH-C48 stamps waitingSince on the waiting events a phone receives, and only on those', async () => {
    const { token } = registerDevice({ name: 'Pixel 3', pubkey: 'pk-push-3' })
    const { phone } = await connectPhone(token)
    emitPlatformEvent('session.state', { sessionId: 'ws-1', state: 'working' })
    emitPlatformEvent('session.state', { sessionId: 'ws-1', state: 'waiting' })
    emitPlatformEvent('agent.needs-input', { sessionId: 'ws-1' })
    emitPlatformEvent('agent.needs-input', { sessionId: 'ws-other' })
    emitPlatformEvent('agent.done', { sessionId: 'ws-1' })
    await vi.waitFor(() => expect(phone.events).toHaveLength(5))
    expect(phone.events.map((e) => e.params)).toEqual([
      { type: 'session.state', payload: { sessionId: 'ws-1', state: 'working' } },
      {
        type: 'session.state',
        payload: { sessionId: 'ws-1', state: 'waiting', waitingSince: 1234 },
      },
      { type: 'agent.needs-input', payload: { sessionId: 'ws-1', waitingSince: 1234 } },
      { type: 'agent.needs-input', payload: { sessionId: 'ws-other' } },
      { type: 'agent.done', payload: { sessionId: 'ws-1' } },
    ])
    phone.ws.terminate()
  })
})
