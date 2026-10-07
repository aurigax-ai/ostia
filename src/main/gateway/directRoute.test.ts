import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect as tlsConnect } from 'node:tls'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { GatewayControlDeps } from './controlDispatch'

vi.mock('electron', () => ({
  app: { getPath: () => process.env.XDG_DATA_HOME, getVersion: () => '0.0.0-test' },
  ipcMain: { handle: () => {} },
}))

const { configureGatewayControl, gatewayHelperPort, startGateway, stopGateway } = await import(
  './server'
)
const { pairAuditLogPath } = await import('./pairing')

const PHONE_ADDRESS = { host: 'desk.example.ts.net', port: 443 }

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

function request(raw: string): Promise<number> {
  return new Promise((resolveStatus, reject) => {
    const tls = tlsConnect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () =>
      tls.write(raw),
    )
    let out = ''
    tls.on('data', (d) => {
      out += d.toString()
    })
    tls.on('close', () => resolveStatus(Number(out.match(/^HTTP\/1\.1 (\d{3})/)?.[1] ?? 0)))
    tls.once('error', reject)
  })
}

function getRequest(host: string): string {
  return `GET /nothing HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`
}

function pairRequest(host: string): string {
  const body = JSON.stringify({ pairCode: 'WRONGCOD', device: { name: 'p', pubkey: 'k' } })
  return `POST /pair HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
}

describe('gateway without Ostia’s Tailscale node', () => {
  let prevXdg: string | undefined

  beforeAll(async () => {
    prevXdg = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), 'ostia-direct-xdg-'))
    configureGatewayControl(deps)
    const started = await startGateway({
      host: '127.0.0.1',
      port: 0,
      tailnet: false,
      phoneAddress: PHONE_ADDRESS,
    })
    port = started.port
    expect(started.helperPort).toBeNull()
  }, 30_000)

  afterAll(async () => {
    await stopGateway()
    const xdg = process.env.XDG_DATA_HOME
    if (prevXdg === undefined) Reflect.deleteProperty(process.env, 'XDG_DATA_HOME')
    else process.env.XDG_DATA_HOME = prevXdg
    if (xdg) rmSync(xdg, { recursive: true, force: true })
  })

  it('TSN-C45 opens no helper listener, so only the bind address listens', () => {
    expect(gatewayHelperPort()).toBeNull()
  })

  it('TSN-C48 accepts the phone address as Host, with or without its port', async () => {
    expect(await request(getRequest(`${PHONE_ADDRESS.host}:${PHONE_ADDRESS.port}`))).toBe(404)
    expect(await request(getRequest('DESK.example.ts.net:443'))).toBe(404)
    expect(await request(getRequest(PHONE_ADDRESS.host))).toBe(404)
    expect(await request(getRequest(`127.0.0.1:${port}`))).toBe(404)
  })

  it('TSN-C48 refuses the phone host on another port and any other Host', async () => {
    expect(await request(getRequest(`${PHONE_ADDRESS.host}:8443`))).toBe(403)
    expect(await request(getRequest(`evil.example:${PHONE_ADDRESS.port}`))).toBe(403)
  })

  it('TSN-C49 audits a loopback peer as this computer, since every peer there is a local tunnel', async () => {
    expect(await request(pairRequest(`127.0.0.1:${port}`))).toBe(401)
    const audit = readFileSync(pairAuditLogPath(), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { ip: string; outcome: string; via?: string })
    expect(audit.at(-1)).toMatchObject({ outcome: 'invalid-code', via: 'this-computer' })
  })
})
