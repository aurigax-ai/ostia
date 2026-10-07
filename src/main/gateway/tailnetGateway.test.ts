import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { type Socket, connect as netConnect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { type TLSSocket, connect as tlsConnect } from 'node:tls'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { storePath } from '../jsonStore'
import type { GatewayControlDeps } from './controlDispatch'
import { registerDevice } from './devices'

vi.mock('electron', () => ({
  app: { getPath: () => process.env.XDG_DATA_HOME, getVersion: () => '0.0.0-test' },
  ipcMain: { handle: () => {} },
}))

const { configureGatewayControl, gatewayStatus, setTailnetHosts, startGateway, stopGateway } =
  await import('./server')
const { pairAuditLogPath } = await import('./pairing')

const root = resolve(__dirname, '../../..')
const helperBinary = join(root, 'out', 'tsnet', 'ostia-tsnet')
const TAILNET_IP = '100.114.10.128'
const TAILNET_NAME = 'ostia-xps15.example.ts.net'

const deps = {
  execCommand: vi.fn(),
  listCommandsFor: vi.fn().mockReturnValue([]),
  getTerminalState: vi.fn(),
  listPanes: vi.fn().mockResolvedValue([]),
  listWorkspaces: vi.fn().mockResolvedValue([]),
  listWorkspaceGroups: vi.fn().mockResolvedValue([]),
  primaryWindowId: vi.fn().mockReturnValue('w1'),
  attachPhoneObserver: vi.fn(),
  ptyResize: vi.fn(),
  ptyWrite: vi.fn(),
  listAsks: vi.fn().mockReturnValue([]),
  answerAsk: vi.fn().mockReturnValue('unknown-ask'),
  agentRunning: vi.fn().mockReturnValue(false),
} satisfies GatewayControlDeps

let port = 0
let helperPort = 0
let fingerprint = ''
const helpers: ChildProcessWithoutNullStreams[] = []

function rawToHelperPort(header: string | Buffer | null): Promise<Socket> {
  return new Promise((resolveSocket, reject) => {
    const socket = netConnect(helperPort, '127.0.0.1', () => {
      if (header !== null) socket.write(header)
      resolveSocket(socket)
    })
    socket.once('error', reject)
  })
}

function proxyLine(peer: string): string {
  return `PROXY TCP4 ${peer} ${TAILNET_IP} 51234 ${port}\r\n`
}

function tlsOver(socket: Socket): Promise<TLSSocket> {
  return new Promise((resolveTls, reject) => {
    const tls = tlsConnect({ socket, rejectUnauthorized: false }, () => resolveTls(tls))
    tls.once('error', reject)
  })
}

function httpOver(tls: TLSSocket, request: string): Promise<number> {
  return new Promise((resolveStatus) => {
    let out = ''
    tls.on('data', (d) => {
      out += d.toString()
    })
    tls.on('close', () => resolveStatus(Number(out.match(/^HTTP\/1\.1 (\d{3})/)?.[1] ?? 0)))
    tls.write(request)
  })
}

async function requestViaHelper(peer: string, request: string): Promise<number> {
  return httpOver(await tlsOver(await rawToHelperPort(proxyLine(peer))), request)
}

function pairRequest(host: string): string {
  const body = JSON.stringify({ pairCode: 'WRONGCOD', device: { name: 'p', pubkey: 'k' } })
  return `POST /pair HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
}

function getRequest(host: string): string {
  return `GET /nothing HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`
}

function closesWithoutResponse(socket: Socket): Promise<string> {
  return new Promise((resolveData) => {
    let data = ''
    socket.on('data', (d) => {
      data += d.toString('latin1')
    })
    socket.on('close', () => resolveData(data))
    socket.on('error', () => {})
  })
}

function startHelper(
  target: number,
): Promise<{ child: ChildProcessWithoutNullStreams; port: number }> {
  const child = spawn(helperBinary, [
    '--listen-local',
    '127.0.0.1:0',
    '--port',
    String(port),
    '--target',
    `127.0.0.1:${target}`,
  ])
  helpers.push(child)
  return new Promise((resolveHelper, reject) => {
    let buf = ''
    child.stdout.on('data', (d) => {
      buf += d.toString()
      for (const line of buf.split('\n')) {
        const ev = line.trim() ? (JSON.parse(line) as { state: string; dnsName?: string }) : null
        if (ev?.state === 'running' && ev.dnsName) {
          resolveHelper({ child, port: Number(ev.dnsName.split(':').pop()) })
        }
      }
    })
    child.once('error', reject)
  })
}

describe('gateway behind the tsnet helper', () => {
  let prevXdg: string | undefined

  beforeAll(async () => {
    prevXdg = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), 'ostia-tailnet-xdg-'))
    const configPath = storePath('gateway-config', 'global')
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, JSON.stringify({ host: '192.168.2.108' }))
    configureGatewayControl(deps)
    const started = await startGateway({ port: 0 })
    port = started.port
    helperPort = started.helperPort
    fingerprint = started.fingerprint
    setTailnetHosts([TAILNET_IP, TAILNET_NAME])
  }, 30_000)

  afterEach(() => {
    for (const child of helpers.splice(0)) child.kill()
  })

  afterAll(async () => {
    await stopGateway()
    const xdg = process.env.XDG_DATA_HOME
    if (prevXdg === undefined) Reflect.deleteProperty(process.env, 'XDG_DATA_HOME')
    else process.env.XDG_DATA_HOME = prevXdg
    if (xdg) rmSync(xdg, { recursive: true, force: true })
  })

  it('TSN-C28 listens only on loopback', () => {
    expect(gatewayStatus()).toMatchObject({ running: true, host: '127.0.0.1' })
  })

  it('TSN-C29 ignores a saved LAN address and stays on loopback', () => {
    expect(gatewayStatus().host).toBe('127.0.0.1')
  })

  it('TSN-C6 rate-limits and audits pairing per tailnet peer', async () => {
    const host = `${TAILNET_IP}:${port}`
    const statuses: number[] = []
    for (let i = 0; i < 6; i++)
      statuses.push(await requestViaHelper('100.64.0.2', pairRequest(host)))
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401])
    expect(statuses[5]).toBe(429)
    expect(await requestViaHelper('100.64.0.3', pairRequest(host))).toBe(401)

    const audit = readFileSync(pairAuditLogPath(), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { ip: string; outcome: string })
    expect(audit.filter((a) => a.ip === '100.64.0.2').map((a) => a.outcome)).toEqual([
      'invalid-code',
      'invalid-code',
      'invalid-code',
      'invalid-code',
      'invalid-code',
      'rate-limited',
    ])
    expect(audit.filter((a) => a.ip === '100.64.0.3').map((a) => a.outcome)).toEqual([
      'invalid-code',
    ])
  })

  it('TSN-C7 closes a helper-port connection that has no PROXY header', async () => {
    const socket = await rawToHelperPort(null)
    const closed = closesWithoutResponse(socket)
    socket.write(getRequest(`${TAILNET_IP}:${port}`))
    expect(await closed).toBe('')
  })

  it('TSN-C8 closes a helper-port connection with a malformed PROXY header', async () => {
    const malformed = [
      'PROXY UNKNOWN\r\n',
      `PROXY TCP4 100.64.0.4 ${TAILNET_IP} abc ${port}\r\n`,
      `PROXY TCP4 not-an-ip ${TAILNET_IP} 51234 ${port}\r\n`,
      `PROXY TCP4 100.64.0.4 ${'9'.repeat(120)}`,
    ]
    for (const header of malformed) {
      const socket = await rawToHelperPort(header)
      const closed = closesWithoutResponse(socket)
      socket.write(getRequest(`${TAILNET_IP}:${port}`))
      expect(await closed).toBe('')
    }
  })

  it('TSN-C9 accepts the tailnet address and MagicDNS name as Host', async () => {
    expect(await requestViaHelper('100.64.0.5', getRequest(`${TAILNET_IP}:${port}`))).toBe(404)
    expect(await requestViaHelper('100.64.0.5', getRequest(`${TAILNET_NAME}:${port}`))).toBe(404)
  })

  it('TSN-C10 refuses any other Host through the helper', async () => {
    expect(await requestViaHelper('100.64.0.6', getRequest(`evil.example:${port}`))).toBe(403)
  })

  it('TSN-C27 rejects an unknown token from a tailnet peer', async () => {
    const raw = await rawToHelperPort(proxyLine('100.64.0.7'))
    const ws = new WebSocket(`wss://${TAILNET_IP}:${port}/ws`, {
      createConnection: () => tlsConnect({ socket: raw, rejectUnauthorized: false }),
    })
    const messages: { id?: number; error?: { code: number } }[] = []
    ws.on('message', (d) => messages.push(JSON.parse(d.toString())))
    const closed = new Promise<number>((resolveCode) => ws.on('close', resolveCode))
    await new Promise<void>((resolveOpen) => ws.once('open', () => resolveOpen()))
    ws.send(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'hello', params: { deviceToken: 'nope' } }),
    )
    expect(await closed).toBe(4001)
    expect(messages[0]?.error?.code).toBe(-32001)
  })

  it('TSN-C4 passes TLS through the helper untouched', async () => {
    const { token } = registerDevice({ name: 'Phone', pubkey: 'pk' })
    const helper = await startHelper(helperPort)
    const ws = new WebSocket(`wss://127.0.0.1:${helper.port}/ws`, {
      rejectUnauthorized: false,
      headers: { host: `127.0.0.1:${port}` },
    })
    const seenFingerprint = new Promise<string>((resolveFp) =>
      ws.once('upgrade', (res) => {
        const cert = (res.socket as TLSSocket).getPeerCertificate(false)
        resolveFp(`sha256/${createHash('sha256').update(cert.raw).digest('base64')}`)
      }),
    )
    await new Promise<void>((resolveOpen) => ws.once('open', () => resolveOpen()))
    const reply = new Promise<{ result?: { deviceId?: string } }>((resolveMsg) =>
      ws.once('message', (d) => resolveMsg(JSON.parse(d.toString()))),
    )
    ws.send(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'hello', params: { deviceToken: token } }),
    )
    expect((await reply).result?.deviceId).toMatch(/^dev_/)
    expect(await seenFingerprint).toBe(fingerprint)
    ws.terminate()
  })

  it('TSN-C5 drops a client when the gateway port is closed and keeps running', async () => {
    const closedPort = await new Promise<number>((resolvePort) => {
      const probe = netConnect(1, '127.0.0.1')
      probe.on('error', () => resolvePort(1))
    })
    const helper = await startHelper(closedPort)
    const client = netConnect(helper.port, '127.0.0.1')
    expect(await closesWithoutResponse(client)).toBe('')
    expect(helper.child.exitCode).toBeNull()
    const second = netConnect(helper.port, '127.0.0.1')
    expect(await closesWithoutResponse(second)).toBe('')
    expect(helper.child.exitCode).toBeNull()
  })
})
