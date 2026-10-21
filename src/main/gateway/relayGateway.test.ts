import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { connect as netConnect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type TLSSocket, connect as tlsConnect } from 'node:tls'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { pushDepsStub } from '../../../test/fixtures/server/pushDepsStub'
import type { GatewayControlDeps } from './controlDispatch'
import { registerDevice } from './devices'
import type { ProxyPeer } from './proxyProtocol'

vi.mock('electron', () => ({
  app: { getPath: () => process.env.XDG_DATA_HOME, getVersion: () => '0.0.0-test' },
  ipcMain: { handle: () => {} },
}))

const {
  configureGatewayControl,
  configureRelayPeers,
  gatewayHelperPort,
  setRelayAddress,
  startGateway,
  stopGateway,
} = await import('./server')
const { newCode, pairAuditLogPath, resetPairRateLimit } = await import('./pairing')

const RELAY_HOST = 'lblabc.relay.test'
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
  fileScope: vi.fn().mockReturnValue({
    home: '/nonexistent-home',
    dataDirs: [],
    rules: { denyRead: [], allowRead: [] },
  }),
  primaryWindowId: vi.fn().mockReturnValue('w1'),
  attachPhoneObserver: vi.fn(),
  ptyWrite: vi.fn(),
  phoneInput: vi.fn(),
  readScreen: vi.fn().mockResolvedValue(''),
  withClipboardImage: vi.fn().mockResolvedValue(true),
  listAsks: vi.fn().mockReturnValue([]),
  answerAsk: vi.fn().mockReturnValue('unknown-ask'),
  agentRunning: vi.fn().mockReturnValue(false),
  watchesTurn: vi.fn().mockResolvedValue(false),
  turnStarted: vi.fn().mockResolvedValue(true),
  paneSince: vi.fn().mockReturnValue(undefined),
  ...pushDepsStub(),
  paneTurns: { list: vi.fn().mockReturnValue([]), output: vi.fn().mockReturnValue(null) },
  redact: vi.fn(async (text: string) => text),
  ownSnippets: vi.fn().mockReturnValue([]),
  remote: vi.fn().mockReturnValue(false),
  startAgent: vi.fn().mockResolvedValue(null),
  phoneWorkspace: vi.fn().mockResolvedValue(null),
  phoneDefaults: vi.fn().mockReturnValue({ set: false, agent: 'claude' }),
  isPhoneWorkspace: vi.fn().mockReturnValue(false),
} satisfies GatewayControlDeps

let port = 0
let helperPort = 0
let nextSourcePort = 50_000
const owned = new Set<string>()
const accepted = vi.fn<(peer: ProxyPeer) => void>()

function key(peer: ProxyPeer): string {
  return `${peer.ip}:${peer.port}`
}

function viaHelper(ip: string, relayed: boolean): Promise<{ tls: TLSSocket; peer: ProxyPeer }> {
  const peer = { ip, port: nextSourcePort++ }
  if (relayed) owned.add(key(peer))
  return new Promise((resolve, reject) => {
    const raw: Socket = netConnect(helperPort, '127.0.0.1', () => {
      raw.write(`PROXY TCP4 ${ip} 127.0.0.1 ${peer.port} ${peer.port}\r\n`)
      const tls = tlsConnect({ socket: raw, rejectUnauthorized: false }, () =>
        resolve({ tls, peer }),
      )
      tls.once('error', reject)
    })
    raw.once('error', reject)
  })
}

function httpStatus(tls: TLSSocket, request: string): Promise<number> {
  return new Promise((resolve) => {
    let out = ''
    tls.on('data', (d) => {
      out += d.toString()
    })
    tls.on('close', () => resolve(Number(out.match(/^HTTP\/1\.1 (\d{3})/)?.[1] ?? 0)))
    tls.write(request)
  })
}

async function getStatus(ip: string, host: string, relayed = true): Promise<number> {
  const { tls } = await viaHelper(ip, relayed)
  return httpStatus(tls, `GET /nothing HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`)
}

async function pair(ip: string, pairCode: string, relayed = true): Promise<ProxyPeer> {
  const { tls, peer } = await viaHelper(ip, relayed)
  const body = JSON.stringify({
    pairCode,
    device: { name: 'p', pubkey: 'k' },
    commit: 'a'.repeat(64),
  })
  await httpStatus(
    tls,
    `POST /pair HTTP/1.1\r\nHost: ${RELAY_HOST}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  )
  return peer
}

async function hello(
  ip: string,
  token: string,
): Promise<{ ws: WebSocket; reply: { result?: { addresses?: unknown[] } }; peer: ProxyPeer }> {
  const { tls, peer } = await viaHelper(ip, true)
  const ws = new WebSocket(`wss://${RELAY_HOST}/ws`, { createConnection: () => tls })
  await new Promise<void>((resolve) => ws.once('open', () => resolve()))
  const reply = new Promise<{ result?: { addresses?: unknown[] } }>((resolve) =>
    ws.once('message', (d) => resolve(JSON.parse(d.toString()))),
  )
  ws.send(
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'hello', params: { deviceToken: token } }),
  )
  return { ws, reply: await reply, peer }
}

function auditLines(): Array<{ ip: string; outcome: string; via?: string }> {
  return readFileSync(pairAuditLogPath(), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { ip: string; outcome: string; via?: string })
}

describe('the gateway behind the relay client', () => {
  let prevXdg: string | undefined

  beforeAll(async () => {
    prevXdg = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), 'ostia-relay-xdg-'))
    configureGatewayControl(deps)
    configureRelayPeers({ owns: (peer) => owned.has(key(peer)), accepted })
    const started = await startGateway({ host: '127.0.0.1', port: 0, tailnet: false, relay: true })
    port = started.port
    helperPort = started.helperPort ?? 0
  }, 30_000)

  beforeEach(() => {
    accepted.mockClear()
    resetPairRateLimit()
    setRelayAddress({ host: RELAY_HOST, port: 8443 })
  })

  afterAll(async () => {
    configureRelayPeers(null)
    await stopGateway()
    const xdg = process.env.XDG_DATA_HOME
    if (prevXdg === undefined) Reflect.deleteProperty(process.env, 'XDG_DATA_HOME')
    else process.env.XDG_DATA_HOME = prevXdg
    if (xdg) rmSync(xdg, { recursive: true, force: true })
  })

  it('RLY-C22 opens the loopback helper listener for the relay even with the tailnet off', () => {
    expect(helperPort).toBeGreaterThan(0)
    expect(gatewayHelperPort()).toBe(helperPort)
    expect(port).toBeGreaterThan(0)
  })

  it('RLY-C23 accepts the relay host as Host while it is known, with or without the public port', async () => {
    expect(await getStatus('198.51.100.7', RELAY_HOST)).toBe(404)
    expect(await getStatus('198.51.100.7', `${RELAY_HOST}:8443`)).toBe(404)
    expect(await getStatus('198.51.100.7', `LBLABC.relay.test`)).toBe(404)
  })

  it('RLY-C24 refuses the relay host on another port, another host, and once the label is gone', async () => {
    expect(await getStatus('198.51.100.7', `${RELAY_HOST}:443`)).toBe(403)
    expect(await getStatus('198.51.100.7', 'other.relay.test')).toBe(403)
    setRelayAddress(null)
    expect(await getStatus('198.51.100.7', RELAY_HOST)).toBe(403)
  })

  it('RLY-C25 audits a relayed pairing attempt with the reported address and via relay', async () => {
    await pair('198.51.100.20', 'WRONGCOD')
    await pair('198.51.100.21', 'WRONGCOD', false)
    const lines = auditLines()
    expect(lines.filter((l) => l.ip === '198.51.100.20').at(-1)).toMatchObject({
      outcome: 'invalid-code',
      via: 'relay',
    })
    expect(lines.filter((l) => l.ip === '198.51.100.21').at(-1)?.via).toBeUndefined()
  })

  it('RLY-C26 rate-limits relayed pairing per reported phone address', async () => {
    for (let i = 0; i < 5; i += 1) await pair('198.51.100.30', 'WRONGCOD')
    await pair('198.51.100.30', 'WRONGCOD')
    expect(
      auditLines()
        .filter((l) => l.ip === '198.51.100.30')
        .at(-1)?.outcome,
    ).toBe('rate-limited')
    await pair('198.51.100.31', 'WRONGCOD')
    expect(
      auditLines()
        .filter((l) => l.ip === '198.51.100.31')
        .at(-1)?.outcome,
    ).toBe('invalid-code')
  })

  it('RLY-C27 tells the relay client a pairing request carried a live code, and only then', async () => {
    const wrong = await pair('198.51.100.40', 'WRONGCOD')
    expect(accepted).not.toHaveBeenCalledWith(wrong)
    const peer = await pair('198.51.100.41', newCode())
    expect(accepted).toHaveBeenCalledTimes(1)
    expect(accepted).toHaveBeenCalledWith(peer)
  })

  it('RLY-C28 does not report a connection the relay client does not own', async () => {
    await pair('198.51.100.42', newCode(), false)
    expect(accepted).not.toHaveBeenCalled()
  })

  it('RLY-C29 tells the relay client a hello with a valid device token was accepted', async () => {
    const { token } = registerDevice({ name: 'Phone', pubkey: 'pk' })
    const { ws, peer } = await hello('198.51.100.50', token)
    expect(accepted).toHaveBeenCalledTimes(1)
    expect(accepted).toHaveBeenCalledWith(peer)
    ws.terminate()
  })

  it('RLY-C30 does not report a hello with an unknown token', async () => {
    const { ws } = await hello('198.51.100.51', 'nope')
    expect(accepted).not.toHaveBeenCalled()
    ws.terminate()
  })

  it('RLY-C31 puts the relay host last in hello.addresses and announces a change', async () => {
    const { token } = registerDevice({ name: 'Phone', pubkey: 'pk2' })
    const { ws, reply } = await hello('198.51.100.52', token)
    expect(reply.result?.addresses).toEqual([{ kind: 'relay', host: RELAY_HOST, port: 8443 }])
    const changed = new Promise<{
      params?: { type?: string; payload?: { addresses?: unknown[] } }
    }>((resolve) => ws.once('message', (d) => resolve(JSON.parse(d.toString()))))
    setRelayAddress({ host: 'lblnew.relay.test', port: 8443 })
    const event = await changed
    expect(event.params?.type).toBe('addresses.changed')
    expect(event.params?.payload?.addresses).toEqual([
      { kind: 'relay', host: 'lblnew.relay.test', port: 8443 },
    ])
    ws.terminate()
  })
})
