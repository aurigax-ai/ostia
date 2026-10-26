import { createHash, randomBytes } from 'node:crypto'
import { connect, type TLSSocket } from 'node:tls'
import WebSocket from 'ws'
import { expect, type Page } from './test'

const PTY_OUTPUT_FRAME = 0x01

function pinnedSocket(serverPort: number, host: string, fingerprint: string): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = connect({
      host: '127.0.0.1',
      port: serverPort,
      servername: host,
      rejectUnauthorized: false,
      checkServerIdentity: (_name, cert) => {
        const seen = `sha256/${createHash('sha256').update(cert.raw).digest('base64')}`
        return seen === fingerprint ? undefined : new Error('certificate does not match the pin')
      },
    })
    socket.once('secureConnect', () => resolve(socket))
    socket.once('error', reject)
  })
}

interface HttpAnswer {
  status: number
  body: Record<string, unknown>
}

function exchange(
  socket: TLSSocket,
  host: string,
  path: string,
  body: Record<string, unknown>,
): Promise<HttpAnswer> {
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      received = Buffer.concat([received, chunk])
      const split = received.indexOf('\r\n\r\n')
      if (split === -1) return
      const head = received.subarray(0, split).toString()
      const length = Number(/content-length: (\d+)/i.exec(head)?.[1] ?? 0)
      const text = received.subarray(split + 4)
      if (text.length < length) return
      socket.off('data', onData)
      resolve({
        status: Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1]),
        body: JSON.parse(text.subarray(0, length).toString() || '{}'),
      })
    }
    socket.on('data', onData)
    socket.once('error', reject)
    socket.write(
      `POST ${path} HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`,
    )
  })
}

export async function signInThroughSettings(win: Page, invite: string): Promise<void> {
  await win.locator('.topbar').getByRole('button', { name: 'Settings' }).click()
  const settings = win.getByRole('region', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Remote' }).click()
  const method = settings.getByRole('combobox', { name: 'Connection method' })
  await method.click()
  await win.getByRole('option', { name: 'Ostia Relay' }).click()
  await expect(method).toContainText('Ostia Relay')
  await settings.getByRole('button', { name: 'Sign in', exact: true }).click()
  const dialog = win.getByRole('dialog', { name: 'Sign in' })
  await dialog.getByRole('textbox', { name: 'Invite code' }).fill(invite)
  await dialog.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(dialog).toBeHidden({ timeout: 20_000 })
}

export interface Pairing {
  host: string
  port: number
  fingerprint: string
  pairCode: string
}

export async function startRelayedRemote(win: Page): Promise<Pairing> {
  const settings = win.getByRole('region', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Remote' }).click()
  await expect(settings.getByRole('combobox', { name: 'Connection method' })).toContainText(
    'Ostia Relay',
  )
  await settings.getByRole('switch', { name: 'Enable remote access' }).click()
  const pairButton = settings.getByRole('button', { name: 'Show QR' })
  await expect(pairButton).toBeEnabled({ timeout: 20_000 })
  await pairButton.click()
  await settings.getByRole('button', { name: 'Connection details' }).click()
  const details = settings.getByRole('textbox', { name: 'Connection details' })
  await expect(details).toHaveValue(/pairCode/)
  return JSON.parse(await details.inputValue()) as Pairing
}

export interface Rpc {
  id?: number
  result?: Record<string, unknown>
  error?: { code: number; message: string }
  params?: { type: string; payload: Record<string, unknown> }
}

export class PhoneSession {
  readonly frames: Buffer[] = []
  readonly events: Rpc[] = []
  private readonly replies = new Map<number, (rpc: Rpc) => void>()
  private nextId = 1

  constructor(readonly ws: WebSocket) {
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        this.frames.push(Buffer.from(data as Buffer))
        return
      }
      const rpc = JSON.parse(data.toString()) as Rpc
      if (rpc.id === undefined) this.events.push(rpc)
      else this.replies.get(rpc.id)?.(rpc)
    })
  }

  call(method: string, params: Record<string, unknown> = {}): Promise<Rpc> {
    const id = this.nextId++
    return new Promise((resolve) => {
      this.replies.set(id, resolve)
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }

  output(): string {
    return Buffer.concat(
      this.frames.filter((f) => f[0] === PTY_OUTPUT_FRAME).map((f) => f.subarray(1)),
    ).toString('utf8')
  }
}

export async function connectPhone(
  serverPort: number,
  pairing: Pairing,
  deviceToken: string,
): Promise<{ phone: PhoneSession; deviceId: string; hello: Record<string, unknown> }> {
  const ws = new WebSocket(`wss://${pairing.host}/ws`, {
    createConnection: () => {
      const socket = connect({
        host: '127.0.0.1',
        port: serverPort,
        servername: pairing.host,
        rejectUnauthorized: false,
        checkServerIdentity: (_name, cert) => {
          const seen = `sha256/${createHash('sha256').update(cert.raw).digest('base64')}`
          return seen === pairing.fingerprint ? undefined : new Error('pin mismatch')
        },
      })
      return socket
    },
  })
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  const phone = new PhoneSession(ws)
  const hello = await phone.call('hello', { deviceToken })
  const deviceId = String(hello.result?.deviceId)
  expect(deviceId).toMatch(/^dev_/)
  return { phone, deviceId, hello: hello.result ?? {} }
}

export async function pairPhone(
  win: Page,
  serverPort: number,
  pairing: Pairing,
  name: string,
): Promise<{ deviceToken: string; socket: TLSSocket }> {
  const settings = win.getByRole('region', { name: 'Settings' })
  const socket = await pinnedSocket(serverPort, pairing.host, pairing.fingerprint)
  const nonce = randomBytes(32)
  const opened = await exchange(socket, pairing.host, '/pair', {
    pairCode: pairing.pairCode,
    device: { name, pubkey: randomBytes(32).toString('base64') },
    commit: createHash('sha256').update(nonce).digest('hex'),
  })
  expect(opened.status).toBe(200)
  const approval = exchange(socket, pairing.host, '/pair/confirm', {
    requestId: opened.body.requestId,
    nonce: nonce.toString('base64'),
  })
  await settings.getByRole('button', { name: `Approve ${name}` }).click()
  const paired = await approval
  expect(paired.status).toBe(200)
  return { deviceToken: String(paired.body.deviceToken), socket }
}
