import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { connect, type TLSSocket } from 'node:tls'
import { PRODUCT_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/product'
import WebSocket from 'ws'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { expectHeld, openWorkspace, runInTerminal } from './helpers'
import { API_HOST, RELAY_DOMAIN, startServer } from './serverHarness'
import { _electron as electron, expect, type Page, test } from './test'

const SERVER_BIN = process.env.OSTIA_SERVER_BIN
const PTY_OUTPUT_FRAME = 0x01
const UNCONFIRMED_LIFETIME_MS = 15_000

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

async function signInThroughSettings(win: Page, invite: string): Promise<void> {
  await win.locator('.topbar').getByRole('button', { name: 'Settings' }).click()
  const settings = win.getByRole('region', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Server' }).click()
  await settings.getByRole('textbox', { name: 'Invite code' }).fill(invite)
  await settings.getByRole('button', { name: 'Sign in' }).click()
  await expect(settings.getByText(/^Signed in as .* with an invite code\.$/)).toBeVisible({
    timeout: 20_000,
  })
}

interface Pairing {
  host: string
  port: number
  fingerprint: string
  pairCode: string
}

async function startRelayedRemote(win: Page): Promise<Pairing> {
  const settings = win.getByRole('region', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Remote' }).click()
  await settings.getByRole('switch', { name: 'Through a relay server' }).click()
  await expect(settings.getByRole('switch', { name: 'Through a relay server' })).toBeChecked()
  await settings.getByRole('switch', { name: 'Enable remote access' }).click()
  const pairButton = settings.getByRole('button', { name: 'Show pairing code' })
  await expect(pairButton).toBeEnabled({ timeout: 20_000 })
  await pairButton.click()
  await settings.getByRole('button', { name: 'Connection details' }).click()
  const details = settings.getByRole('textbox', { name: 'Connection details' })
  await expect(details).toHaveValue(/pairCode/)
  return JSON.parse(await details.inputValue()) as Pairing
}

interface Rpc {
  id: number
  result?: Record<string, unknown>
  error?: { code: number; message: string }
}

class PhoneSession {
  readonly frames: Buffer[] = []
  private readonly replies = new Map<number, (rpc: Rpc) => void>()
  private nextId = 1

  constructor(readonly ws: WebSocket) {
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        this.frames.push(Buffer.from(data as Buffer))
        return
      }
      const rpc = JSON.parse(data.toString()) as Rpc
      this.replies.get(rpc.id)?.(rpc)
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

async function connectPhone(
  serverPort: number,
  pairing: Pairing,
  deviceToken: string,
): Promise<{ phone: PhoneSession; deviceId: string }> {
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
  return { phone, deviceId }
}

test.describe('the relay server end to end', () => {
  test.skip(!SERVER_BIN, 'set OSTIA_SERVER_BIN to a built ostia-server')

  test('a phone pairs and attaches a pane through the relay, pinned to the gateway certificate', async () => {
    test.setTimeout(150_000)
    const server = await startServer(SERVER_BIN ?? '')
    const dataHome = freshDataHome()
    const launch = isolatedLaunch(dataHome)
    const app = await electron.launch({
      ...launch,
      args: ['--password-store=basic', ...launch.args],
      env: {
        ...launch.env,
        OSTIA_SERVER_URL: `https://${API_HOST}:${server.port}`,
        NODE_EXTRA_CA_CERTS: server.caPath,
      },
    })
    try {
      await app.evaluate(({ safeStorage }) => safeStorage.setUsePlainTextEncryption(true))
      const win = await app.firstWindow()
      await win.waitForLoadState('domcontentloaded')
      await openWorkspace(win)
      const marker = `relay-${randomBytes(4).toString('hex')}`
      await runInTerminal(win, `echo ${marker}`)
      await expect(win.locator('.xterm-rows').first()).toContainText(marker, { timeout: 15_000 })

      await signInThroughSettings(win, server.invite())
      const pairing = await startRelayedRemote(win)
      expect(pairing.host).toMatch(new RegExp(`\\.${RELAY_DOMAIN.replace('.', '\\.')}$`))
      expect(pairing.port).toBe(443)

      const settings = win.getByRole('region', { name: 'Settings' })
      const socket = await pinnedSocket(server.port, pairing.host, pairing.fingerprint)
      const nonce = randomBytes(32)
      const opened = await exchange(socket, pairing.host, '/pair', {
        pairCode: pairing.pairCode,
        device: { name: 'E2E phone', pubkey: randomBytes(32).toString('base64') },
        commit: createHash('sha256').update(nonce).digest('hex'),
      })
      expect(opened.status).toBe(200)
      const approval = exchange(socket, pairing.host, '/pair/confirm', {
        requestId: opened.body.requestId,
        nonce: nonce.toString('base64'),
      })
      await settings.getByRole('button', { name: 'Approve E2E phone' }).click()
      const paired = await approval
      expect(paired.status).toBe(200)
      const deviceToken = String(paired.body.deviceToken)

      const { phone, deviceId } = await connectPhone(server.port, pairing, deviceToken)
      const listed = await phone.call('pane.list')
      const panes = (listed.result?.panes ?? []) as Array<{ paneId: string; kind: string }>
      const terminal = panes.find((pane) => pane.kind === 'terminal')
      expect(terminal).toBeDefined()
      const attached = await phone.call('pty.attach', { paneId: terminal?.paneId })
      expect(attached.error).toBeUndefined()
      await expect.poll(() => phone.output(), { timeout: 15_000 }).toContain(marker)

      await expectHeld(
        async () => (await phone.call('whoami')).result?.deviceId,
        deviceId,
        UNCONFIRMED_LIFETIME_MS + 2_000,
        'a confirmed relay stream outlives the unconfirmed limit',
      )

      const audit = readFileSync(join(dataHome, PRODUCT_NAME, 'gateway-pair-audit.log'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { ip: string; outcome: string; via?: string })
      expect(audit.at(-1)).toMatchObject({ ip: '127.0.0.1', outcome: 'ok', via: 'relay' })
      phone.ws.terminate()
      socket.destroy()
    } finally {
      await app.close()
      await server.stop()
    }
  })
})
