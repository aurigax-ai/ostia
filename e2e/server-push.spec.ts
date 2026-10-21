import { readFileSync } from 'node:fs'
import { request } from 'node:https'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { type FakePush, startFakePush } from './fakePush'
import { expectHeld, openWorkspace, runInTerminal } from './helpers'
import {
  connectPhone,
  type Pairing,
  type PhoneSession,
  pairPhone,
  signInThroughSettings,
  startRelayedRemote,
} from './relayPhone'
import { API_HOST, startServer } from './serverHarness'
import { _electron as electron, expect, type Page, test } from './test'

const SERVER_BIN = process.env.OSTIA_SERVER_BIN
const FCM_TOKEN = 'fcm-registration-token-e2e'
const PING_GAP_MS = 31_000
const NAME = 'E2E phone'

function registerAtServer(
  server: string,
  caPath: string,
  ticket: string,
): Promise<{ status: number; handle: string }> {
  const payload = JSON.stringify({ platform: 'fcm', token: FCM_TOKEN, ticket })
  return new Promise((resolve, reject) => {
    const req = request(
      `${server}/v1/push/register`,
      {
        method: 'POST',
        ca: readFileSync(caPath),
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let text = ''
        res.on('data', (chunk) => {
          text += chunk
        })
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            handle: String((JSON.parse(text || '{}') as { handle?: string }).handle),
          }),
        )
      },
    )
    req.once('error', reject)
    req.end(payload)
  })
}

async function notifyFromTerminal(win: Page): Promise<void> {
  const settings = win.getByRole('region', { name: 'Settings' })
  if (await settings.isVisible()) {
    await win.locator('.rail-tab').filter({ hasNotText: 'Settings' }).first().click()
  }
  await runInTerminal(win, 'ostia notify "secret title" "secret body"')
}

function pushConfigs(phone: PhoneSession): Array<Record<string, unknown>> {
  return phone.events
    .filter((e) => e.params?.type === 'push.config')
    .map((e) => e.params?.payload ?? {})
}

async function waitForMessages(push: FakePush, count: number, win: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        if (push.messages.length < count) await notifyFromTerminal(win)
        return push.messages.length
      },
      { timeout: 40_000, intervals: [1_500] },
    )
    .toBe(count)
}

test.describe('push through the server end to end', () => {
  test.skip(!SERVER_BIN, 'set OSTIA_SERVER_BIN to a built ostia-server')

  test('a phone registers a handle and the desktop wakes it only while it has no live socket', async () => {
    test.setTimeout(240_000)
    const push = await startFakePush()
    const server = await startServer(SERVER_BIN ?? '', {
      push: { serviceAccountFile: push.serviceAccountFile, endpoint: push.endpoint },
    })
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

      await signInThroughSettings(win, server.invite())
      const pairing: Pairing = await startRelayedRemote(win)
      const { deviceToken, socket } = await pairPhone(win, server.port, pairing, NAME)
      const settings = win.getByRole('region', { name: 'Settings' })
      const pushSwitch = settings.getByRole('switch', {
        name: `Notify through the server, ${NAME}`,
      })

      const first = await connectPhone(server.port, pairing, deviceToken)
      expect(first.hello.push).toBeUndefined()
      await expect(pushSwitch).toBeEnabled()
      await expect(pushSwitch).not.toBeChecked()

      await pushSwitch.click()
      await expect(pushSwitch).toBeChecked()
      await expect(settings.getByText(/Waiting for the phone to register/)).toBeVisible()
      const serverUrl = `https://${API_HOST}:${server.port}`
      await expect
        .poll(() => pushConfigs(first.phone))
        .toEqual([{ server: serverUrl, registered: false }])

      const ticket = await first.phone.call('push.ticket')
      expect(ticket.error).toBeUndefined()
      const registered = await registerAtServer(
        serverUrl,
        server.caPath,
        String(ticket.result?.ticket),
      )
      expect(registered.status).toBe(201)
      expect(
        (await first.phone.call('push.register', { handle: registered.handle, platform: 'fcm' }))
          .result,
      ).toEqual({ ok: true })
      await expect(settings.getByText(/^On\. Your server wakes this phone/)).toBeVisible()

      first.phone.ws.terminate()
      await waitForMessages(push, 1, win)
      const [message] = push.messages
      expect(message?.authorized).toBe(true)
      expect(message?.body.message.token).toBe(FCM_TOKEN)
      expect(message?.body.message.data).toEqual({ v: '1' })
      expect(Object.keys(message?.body.message ?? {}).sort()).toEqual(['android', 'data', 'token'])
      expect(JSON.stringify(push.messages)).not.toContain('secret')
      const pingedAt = Date.now()

      const second = await connectPhone(server.port, pairing, deviceToken)
      expect(second.hello.push).toEqual({ server: serverUrl, registered: true })
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, PING_GAP_MS - (Date.now() - pingedAt))),
      )
      await notifyFromTerminal(win)
      await expect
        .poll(() => second.phone.events.some((e) => e.params?.type === 'notify'))
        .toBe(true)
      await expectHeld(
        async () => push.messages.length,
        1,
        3_000,
        'a live socket suppresses the ping',
      )

      second.phone.ws.terminate()
      await waitForMessages(push, 2, win)
      expect(push.messages.map((m) => m.body.message.data)).toEqual([{ v: '1' }, { v: '1' }])
      expect(push.unexpected).toEqual([])
      expect(push.tokenExchanges()).toBeGreaterThan(0)
      socket.destroy()
    } finally {
      await app.close()
      await server.stop()
      await push.stop()
    }
  })
})
