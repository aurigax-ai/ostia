import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { GatewayTailnetState } from '../../shared/types'
import type { Tailnet } from './tailnet'

vi.mock('electron', () => ({
  app: { getPath: () => process.env.XDG_DATA_HOME, getVersion: () => '0.0.0-test' },
  ipcMain: { handle: () => {} },
}))

vi.mock('../controlServer', () => ({ registerControlMethod: () => {} }))

const { startGateway, stopGateway } = await import('./server')
const { configureTailnet, gatewayPair } = await import('./index')
const { newCode, resetCodes, resetPairRateLimit } = await import('./pairing')
const { answerPairRequest, listPairRequests, onPairRequestsChanged, resetPairRequests } =
  await import('./pairRequests')
const { checkCode } = await import('./pairCheck')
const { list: listDevices } = await import('./devices')

interface Reply {
  status: number
  body: Record<string, unknown>
}

let port = 0
let fingerprint = ''

function post(path: string, body: unknown): { reply: Promise<Reply>; abort: () => void } {
  const data = JSON.stringify(body)
  let abort = (): void => {}
  const reply = new Promise<Reply>((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        rejectUnauthorized: false,
        headers: {
          Host: `127.0.0.1:${port}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let text = ''
        res.on('data', (d) => {
          text += d.toString()
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }))
      },
    )
    req.on('error', reject)
    abort = () => req.destroy()
    req.end(data)
  })
  return { reply, abort }
}

function phone(name = 'Pixel 9') {
  const nonce = randomBytes(32)
  const pubkey = `pk-${randomBytes(4).toString('hex')}`
  return {
    name,
    pubkey,
    nonce,
    start: (pairCode: string) =>
      post('/pair', {
        pairCode,
        device: { name, pubkey },
        commit: createHash('sha256').update(nonce).digest('hex'),
      }).reply,
    confirm: (requestId: unknown, nonceB64 = nonce.toString('base64')) =>
      post('/pair/confirm', { requestId, nonce: nonceB64 }),
  }
}

function requestsChange(pred: (n: number) => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (pred(listPairRequests().length)) return resolve()
    const off = onPairRequestsChanged(() => {
      if (!pred(listPairRequests().length)) return
      off()
      resolve()
    })
  })
}

describe('pairing requests wait for the human', () => {
  let prevXdg: string | undefined

  beforeAll(async () => {
    prevXdg = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), 'ostia-pair-flow-'))
    const started = await startGateway({ port: 0 })
    port = started.port
    fingerprint = started.fingerprint
  }, 30_000)

  afterEach(() => {
    resetPairRequests()
    resetCodes()
    resetPairRateLimit()
  })

  afterAll(async () => {
    await stopGateway()
    const xdg = process.env.XDG_DATA_HOME
    if (prevXdg === undefined) Reflect.deleteProperty(process.env, 'XDG_DATA_HOME')
    else process.env.XDG_DATA_HOME = prevXdg
    if (xdg) rmSync(xdg, { recursive: true, force: true })
  })

  it('CPD-C13 shows the phone and its check code, and pairs it on Approve', async () => {
    const p = phone()
    const started = await p.start(newCode())
    expect(started.status).toBe(200)
    expect(started.body.deviceToken).toBeUndefined()
    const confirm = p.confirm(started.body.requestId)
    await requestsChange((n) => n === 1)

    const desktopNonce = Buffer.from(String(started.body.nonce), 'base64')
    const [pending] = listPairRequests()
    expect(pending.name).toBe('Pixel 9')
    expect(pending.checkCode).toBe(checkCode(fingerprint, p.pubkey, p.nonce, desktopNonce))

    expect(answerPairRequest(pending.requestId, true)).toBe(true)
    const done = await confirm.reply
    expect(done.status).toBe(200)
    expect(typeof done.body.deviceToken).toBe('string')
    expect(listDevices().some((d) => d.pubkey === p.pubkey)).toBe(true)
    expect(listPairRequests()).toEqual([])
  })

  it('CPD-C14 tells the phone the desktop declined and adds no device', async () => {
    const p = phone()
    const started = await p.start(newCode())
    const confirm = p.confirm(started.body.requestId)
    await requestsChange((n) => n === 1)

    expect(answerPairRequest(listPairRequests()[0].requestId, false)).toBe(true)
    const done = await confirm.reply
    expect(done).toEqual({ status: 403, body: { error: 'declined' } })
    expect(listDevices().some((d) => d.pubkey === p.pubkey)).toBe(false)
  })

  it('CPD-C17 asks for approval when the code came from the QR', async () => {
    let state: GatewayTailnetState = { state: 'running', ip: '127.0.0.1', dnsName: null }
    configureTailnet({ state: () => state } as unknown as Tailnet, { openExternal: () => {} })
    const qr = gatewayPair()
    state = { state: 'off' }
    if ('error' in qr) throw new Error(qr.error)

    const p = phone()
    const started = await p.start(qr.pairCode)
    expect(started.status).toBe(200)
    expect(started.body.deviceToken).toBeUndefined()
    const confirm = p.confirm(started.body.requestId)
    await requestsChange((n) => n === 1)
    expect(listDevices().some((d) => d.pubkey === p.pubkey)).toBe(false)
    answerPairRequest(listPairRequests()[0].requestId, true)
    expect((await confirm.reply).status).toBe(200)
  })

  it('CPD-C19 ends the request when the revealed nonce does not match the commit', async () => {
    const code = newCode()
    const p = phone()
    const started = await p.start(code)
    const wrong = randomBytes(32).toString('base64')
    const done = await p.confirm(started.body.requestId, wrong).reply
    expect(done).toEqual({ status: 400, body: { error: 'commit-mismatch' } })
    expect(listPairRequests()).toEqual([])
    expect((await p.confirm(started.body.requestId).reply).status).toBe(404)
    expect((await phone().start(code)).status).toBe(401)
  })

  it('CPD-C20 refuses a second request with the same code', async () => {
    const code = newCode()
    const first = await phone().start(code)
    expect(first.status).toBe(200)
    expect(typeof first.body.requestId).toBe('string')
    const second = await phone().start(code)
    expect(second).toEqual({ status: 401, body: { error: 'invalid-pair-code' } })
  })

  it('CPD-C21 drops the request when the phone disconnects', async () => {
    const p = phone()
    const started = await p.start(newCode())
    const confirm = p.confirm(started.body.requestId)
    confirm.reply.catch(() => {})
    await requestsChange((n) => n === 1)
    confirm.abort()
    await requestsChange((n) => n === 0)
    expect(listPairRequests()).toEqual([])
  })

  it('CPD-C23 rejects the old one-step body and makes no request', async () => {
    const code = newCode()
    const res = await post('/pair', { pairCode: code, device: { name: 'Old', pubkey: 'pk-old' } })
      .reply
    expect(res.status).toBe(400)
    expect(listPairRequests()).toEqual([])
    expect(listDevices().some((d) => d.pubkey === 'pk-old')).toBe(false)
  })
})
