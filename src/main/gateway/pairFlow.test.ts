import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { GatewayTailnetState } from '../../shared/gateway/gatewayApi'
import type { Tailnet } from './tailnet'

vi.mock('electron', () => ({
  app: { getPath: () => process.env.XDG_DATA_HOME, getVersion: () => '0.0.0-test' },
  ipcMain: { handle: () => {} },
}))

vi.mock('../control/controlServer', () => ({ registerControlMethod: () => {} }))

const { startGateway, stopGateway } = await import('./server')
const { configureTailnet, gatewayPair } = await import('./gatewayIpc')
const { newCode, pairAuditLogPath, resetCodes, resetPairRateLimit } = await import('./pairing')
const { answerPairRequest, listPairRequests, onPairRequestsChanged, resetPairRequests } =
  await import('./pairRequests')
const { checkCode } = await import('./pairCheck')
const { list: listDevices, setDeviceCap, touchDevice, verifyToken } = await import('./devices')

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

function phone(name = 'Pixel 9', installId?: string) {
  const nonce = randomBytes(32)
  const pubkey = `pk-${randomBytes(4).toString('hex')}`
  return {
    name,
    pubkey,
    nonce,
    start: (pairCode: string) =>
      post('/pair', {
        pairCode,
        device: { name, pubkey, installId },
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

async function pairPhone(
  p: ReturnType<typeof phone>,
): Promise<{ replaces: unknown; deviceId: string; token: string; replaced: string[] }> {
  const started = await p.start(newCode())
  const confirm = p.confirm(started.body.requestId)
  await requestsChange((n) => n === 1)
  const [pending] = listPairRequests()
  const answer = answerPairRequest(pending.requestId, true)
  const done = await confirm.reply
  return {
    replaces: pending.replaces,
    deviceId: String(done.body.deviceId),
    token: String(done.body.deviceToken),
    replaced: answer?.replaced ?? [],
  }
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

    expect(answerPairRequest(pending.requestId, true)).toEqual({
      replaced: [],
      replacedHandles: [],
    })
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

    expect(answerPairRequest(listPairRequests()[0].requestId, false)).toEqual({
      replaced: [],
      replacedHandles: [],
    })
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

  it('PID-C1 replaces the row and the token, keeping the grants and taking the name the phone sends now, when the same install identity pairs again', async () => {
    const id = randomBytes(16).toString('hex')
    const first = await pairPhone(phone('Pixel 9', id))
    expect(first.replaces).toBeNull()
    setDeviceCap(first.deviceId, 'input', true)

    touchDevice(first.deviceId)
    const second = await pairPhone(phone('Pixel 9 Pro', id))
    expect(second.replaces).toMatchObject({
      name: 'Pixel 9',
      lastSeenAt: expect.any(String),
      caps: ['read', 'notify', 'input'],
    })
    expect(second.replaced).toEqual([first.deviceId])
    const rows = listDevices().filter((d) => d.installId === id)
    expect(rows.map((d) => d.deviceId)).toEqual([second.deviceId])
    expect(rows[0].name).toBe('Pixel 9 Pro')
    expect(rows[0].caps).toEqual(['read', 'notify', 'input'])
    expect(verifyToken(first.token)).toBeNull()
    expect(verifyToken(second.token)?.deviceId).toBe(second.deviceId)
  })

  it('PID-C2 keeps two rows for two different install identities', async () => {
    const a = await pairPhone(phone('Pixel 9', randomBytes(16).toString('hex')))
    const b = await pairPhone(phone('Pixel 9', randomBytes(16).toString('hex')))
    expect(b.replaces).toBeNull()
    expect(b.replaced).toEqual([])
    expect(listDevices().find((d) => d.deviceId === b.deviceId)?.caps).toEqual(['read', 'notify'])
    expect(verifyToken(a.token)?.deviceId).toBe(a.deviceId)
    expect(verifyToken(b.token)?.deviceId).toBe(b.deviceId)
  })

  it('PID-C3 keeps a phone that sends no identity as its own row each time', async () => {
    const a = await pairPhone(phone('Pixel 9'))
    const b = await pairPhone(phone('Pixel 9'))
    expect(b.replaced).toEqual([])
    expect(verifyToken(a.token)).not.toBeNull()
    expect(verifyToken(b.token)).not.toBeNull()
  })

  it('PID-C4 leaves the old row alone until the human approves', async () => {
    const id = randomBytes(16).toString('hex')
    const first = await pairPhone(phone('Pixel 9', id))
    const p = phone('Pixel 9', id)
    const started = await p.start(newCode())
    p.confirm(started.body.requestId)
    await requestsChange((n) => n === 1)
    expect(verifyToken(first.token)?.deviceId).toBe(first.deviceId)
    answerPairRequest(listPairRequests()[0].requestId, false)
    expect(verifyToken(first.token)?.deviceId).toBe(first.deviceId)
  })

  it('PID-C5 refuses an install identity that is not a plain id', async () => {
    const p = phone('Pixel 9', 'short')
    expect((await p.start(newCode())).status).toBe(400)
  })

  it('PID-C6 never writes the install identity to the audit log', async () => {
    const id = randomBytes(16).toString('hex')
    await pairPhone(phone('Pixel 9', id))
    expect(readFileSync(pairAuditLogPath(), 'utf8')).not.toContain(id)
  })

  it('PID-C14 refuses a name with control, bidi or invisible characters', async () => {
    for (const name of ['Pixel\n9', 'Pixel\u202E9', 'Pixel\u200B9', '   ']) {
      expect((await phone(name).start(newCode())).status).toBe(400)
    }
  })
})
