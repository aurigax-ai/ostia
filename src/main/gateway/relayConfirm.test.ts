import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duplex } from 'node:stream'
import { connect, type TLSSocket } from 'node:tls'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { type AccountHarness, signedIn } from '../../../test/fixtures/server/accountHarness'
import type { PhoneStream } from '../../../test/fixtures/server/fakeRelay'
import type { GatewayControlDeps } from './controlDispatch'
import { RelayClient } from './relayClient'

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
const { newCode, resetPairRateLimit } = await import('./pairing')
const { answerPairRequest } = await import('./pairRequests')

const UNCONFIRMED_MS = 400
const RELAY_HOST = 'lbldevice1.relay.test'

let harness: AccountHarness
let client: RelayClient
let prevXdg: string | undefined
let nextPort = 43_000

function duplexOver(phone: PhoneStream): Duplex {
  const duplex = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, done) {
      void phone.accepted.then(() => {
        phone.send(chunk)
        done()
      })
    },
  })
  phone.onData((data) => duplex.push(data))
  void phone.closed.then(() => duplex.push(null))
  return duplex
}

interface Call {
  phone: PhoneStream
  tls: TLSSocket
  answer: Promise<{ status: number; body: Record<string, unknown> }>
}

function post(path: string, body: Record<string, unknown>): Call {
  const phone = harness.server.phoneConnect(`203.0.113.5:${nextPort++}`)
  const tls = connect({ socket: duplexOver(phone), rejectUnauthorized: false })
  tls.on('error', () => {})
  const payload = JSON.stringify(body)
  const answer = new Promise<{ status: number; body: Record<string, unknown> }>((resolve) => {
    let received = ''
    tls.on('data', (chunk: Buffer) => {
      received += chunk.toString()
      const split = received.indexOf('\r\n\r\n')
      if (split === -1) return
      const length = Number(/content-length: (\d+)/i.exec(received)?.[1] ?? 0)
      const text = received.slice(split + 4)
      if (text.length < length) return
      resolve({
        status: Number(/^HTTP\/1\.1 (\d{3})/.exec(received)?.[1]),
        body: JSON.parse(text || '{}'),
      })
    })
  })
  tls.write(
    `POST ${path} HTTP/1.1\r\nHost: ${RELAY_HOST}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`,
  )
  return { phone, tls, answer }
}

async function openPairRequest(): Promise<{ requestId: string; nonce: Buffer }> {
  const nonce = randomBytes(32)
  const call = post('/pair', {
    pairCode: newCode(),
    device: { name: 'Phone', pubkey: 'pk' },
    commit: createHash('sha256').update(nonce).digest('hex'),
  })
  const opened = await call.answer
  expect(opened.status).toBe(200)
  call.tls.destroy()
  return { requestId: String(opened.body.requestId), nonce }
}

const deps = {} as unknown as GatewayControlDeps

beforeAll(async () => {
  prevXdg = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), 'ostia-relay-confirm-'))
  harness = await signedIn({ unconfirmedMs: UNCONFIRMED_MS })
  configureGatewayControl(deps)
  await startGateway({ host: '127.0.0.1', port: 0, tailnet: false, relay: true })
  client = new RelayClient({
    account: harness.account,
    helperPort: gatewayHelperPort,
    onState: () => {},
    onAddress: setRelayAddress,
  })
  configureRelayPeers(client)
  client.start()
  await vi.waitFor(() => expect(client.status().state).toBe('listening'))
}, 30_000)

afterEach(() => resetPairRateLimit())

afterAll(async () => {
  client.stop()
  configureRelayPeers(null)
  await stopGateway()
  await harness.close()
  const xdg = process.env.XDG_DATA_HOME
  if (prevXdg === undefined) Reflect.deleteProperty(process.env, 'XDG_DATA_HOME')
  else process.env.XDG_DATA_HOME = prevXdg
  if (xdg) rmSync(xdg, { recursive: true, force: true })
})

describe('confirming a relay stream on /pair/confirm', () => {
  it('RLY-C57 keeps a fresh connection that waits for the human past the unconfirmed limit', async () => {
    const { requestId, nonce } = await openPairRequest()
    const waiting = post('/pair/confirm', { requestId, nonce: nonce.toString('base64') })
    await vi.waitFor(() => expect(harness.server.confirmed).toContain(waiting.phone.id))
    let closed = false
    void waiting.phone.closed.then(() => {
      closed = true
    })
    await new Promise((resolve) => setTimeout(resolve, UNCONFIRMED_MS * 2.5))
    expect(closed).toBe(false)
    answerPairRequest(requestId, true)
    const paired = await waiting.answer
    expect(paired.status).toBe(200)
    expect(paired.body.deviceToken).toBeTypeOf('string')
    waiting.tls.destroy()
  })

  it('RLY-C58 does not confirm a connection that names no pending request, and the server drops it', async () => {
    const stray = post('/pair/confirm', {
      requestId: 'no-such-request',
      nonce: randomBytes(32).toString('base64'),
    })
    expect((await stray.answer).status).toBe(404)
    await stray.phone.closed
    expect(harness.server.confirmed).not.toContain(stray.phone.id)
  })

  it('RLY-C59 does not confirm a request id with the wrong nonce', async () => {
    const { requestId } = await openPairRequest()
    const forged = post('/pair/confirm', {
      requestId,
      nonce: randomBytes(32).toString('base64'),
    })
    expect((await forged.answer).status).toBe(400)
    await forged.phone.closed
    expect(harness.server.confirmed).not.toContain(forged.phone.id)
  })
})
