import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PRODUCT_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/product'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { expectHeld, openWorkspace, runInTerminal } from './helpers'
import { connectPhone, pairPhone, signInThroughSettings, startRelayedRemote } from './relayPhone'
import { API_HOST, RELAY_DOMAIN, startServer } from './serverHarness'
import { _electron as electron, expect, test } from './test'

const SERVER_BIN = process.env.OSTIA_SERVER_BIN
const UNCONFIRMED_LIFETIME_MS = 15_000

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
      await expect(win.locator('.terminal-text').first()).toContainText(marker, { timeout: 15_000 })

      await signInThroughSettings(win, server.invite())
      const pairing = await startRelayedRemote(win)
      expect(pairing.host).toMatch(new RegExp(`\\.${RELAY_DOMAIN.replace('.', '\\.')}$`))
      expect(pairing.port).toBe(443)

      const { deviceToken, socket } = await pairPhone(win, server.port, pairing, 'E2E phone')

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
