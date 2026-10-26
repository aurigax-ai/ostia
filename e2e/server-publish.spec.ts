import { createDecipheriv } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { request } from 'node:https'
import { join } from 'node:path'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace, runInTerminal } from './helpers'
import { API_HOST, type RunningServer, startServer } from './serverHarness'
import { type ElectronApplication, _electron as electron, expect, type Page, test } from './test'

const SERVER_BIN = process.env.OSTIA_SERVER_BIN
const SLOW = { timeout: 30_000 }
const NONCE_BYTES = 12
const TAG_BYTES = 16
const ARTIFACT = 'plan.md'

interface Answer {
  status: number
  body: Buffer
}

function fromApiHost(server: RunningServer, path: string, method = 'GET'): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: server.port,
        path,
        method,
        servername: API_HOST,
        headers: { Host: `${API_HOST}:${server.port}` },
        ca: readFileSync(server.caPath),
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

function openShare(id: string, key: Buffer, blob: Buffer): string {
  expect(blob[0]).toBe(1)
  const nonce = blob.subarray(1, 1 + NONCE_BYTES)
  const sealed = blob.subarray(1 + NONCE_BYTES, blob.length - TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAAD(Buffer.from(`ostia-share/1:${id}`, 'utf8'))
  decipher.setAuthTag(blob.subarray(blob.length - TAG_BYTES))
  return Buffer.concat([decipher.update(sealed), decipher.final()]).toString('utf8')
}

const withoutBuildTime = (page: string): string => page.replace(/"built":"[^"]*"/, '"built":""')

const settingsOf = (win: Page) => win.getByRole('region', { name: 'Settings' })

async function launchApp(server: RunningServer, dataHome: string) {
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
  await app.evaluate(({ safeStorage }) => safeStorage.setUsePlainTextEncryption(true))
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  return { app, win }
}

async function signIn(win: Page, invite: string): Promise<void> {
  await win.locator('.topbar').getByRole('button', { name: 'Settings' }).click()
  const settings = settingsOf(win)
  await settings.getByRole('button', { name: 'Shared artifacts', exact: true }).click()
  await settings.getByRole('button', { name: 'Sign in', exact: true }).click()
  const dialog = win.getByRole('dialog', { name: 'Sign in' })
  await dialog.getByRole('textbox', { name: 'Invite code' }).fill(invite)
  await dialog.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(dialog).toBeHidden(SLOW)
  await expect(settings.getByRole('button', { name: 'Sign in', exact: true })).toBeHidden(SLOW)
}

async function openArtifact(win: Page): Promise<void> {
  await runInTerminal(
    win,
    `printf "# Plan\\n\\nship it on friday\\n" > "$OSTIA_ARTIFACTS/${ARTIFACT}" && ostia open "$OSTIA_ARTIFACTS/${ARTIFACT}"`,
  )
  await expect(win.locator('.pane-header', { hasText: ARTIFACT })).toBeVisible(SLOW)
}

async function savedPortable(app: ElectronApplication, win: Page, target: string): Promise<string> {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = (async () => ({
      canceled: false,
      filePath,
    })) as typeof dialog.showSaveDialog
  }, target)
  const header = win.locator('.pane-header', { hasText: ARTIFACT })
  await header.getByRole('button', { name: 'More ways to take this file' }).click()
  await win.getByRole('menuitem', { name: 'Save Portable File…' }).click()
  await expect.poll(() => existsSync(target), SLOW).toBe(true)
  return readFileSync(target, 'utf8')
}

test.describe('publishing an artifact to the real server', () => {
  test.skip(!SERVER_BIN, 'set OSTIA_SERVER_BIN to a built ostia-server')

  test('an encrypted link share opens with the key of the copied link and is gone after Delete', async () => {
    test.setTimeout(180_000)
    const server = await startServer(SERVER_BIN ?? '')
    const dataHome = freshDataHome()
    const { app, win } = await launchApp(server, dataHome)
    try {
      await openWorkspace(win)
      const header = win.locator('.pane-header', { hasText: ARTIFACT })
      await openArtifact(win)
      await header.getByRole('button', { name: 'More ways to take this file' }).click()
      await expect(win.getByRole('menuitem', { name: /Publish….*Not signed in/ })).toHaveAttribute(
        'aria-disabled',
        'true',
      )
      await win.keyboard.press('Escape')

      await signIn(win, server.invite())
      await win.keyboard.press('Escape')
      await header.getByRole('button', { name: 'More ways to take this file' }).click()
      await win.getByRole('menuitem', { name: 'Publish…' }).click()
      const dialog = win.getByRole('dialog')
      await expect(dialog.getByText(/could serve a page that leaks the key/)).toBeVisible()
      await dialog.getByRole('button', { name: 'Publish', exact: true }).click()
      await expect(dialog.getByText('Published')).toBeVisible(SLOW)
      await dialog.getByRole('button', { name: 'Copy link' }).click()
      await expect(dialog.getByRole('button', { name: 'Link copied' })).toBeVisible()
      const link = new URL(await app.evaluate(({ clipboard }) => clipboard.readText()))
      await dialog.getByRole('button', { name: 'Close' }).click()

      expect(link.hostname).toBe(API_HOST)
      const id = /^\/s\/([a-z2-7]+)$/.exec(link.pathname)?.[1] ?? ''
      expect(id).not.toBe('')
      const key = Buffer.from(link.hash.replace(/^#k=/, ''), 'base64url')
      expect(key.length).toBe(32)

      const meta = await fromApiHost(server, `/s/${id}/meta`)
      expect(meta.status).toBe(200)
      expect(JSON.parse(meta.body.toString())).toMatchObject({ v: 1, mode: 'link' })
      const blob = await fromApiHost(server, `/s/${id}/blob`)
      expect(blob.status).toBe(200)
      expect((await fromApiHost(server, `/s/${id}/view`, 'POST')).status).toBe(204)
      const opened = openShare(id, key, blob.body)
      expect(blob.body.toString('utf8')).not.toContain('ship it on friday')

      const portable = await savedPortable(app, win, join(dataHome, 'home', 'saved.html'))
      expect(withoutBuildTime(opened)).toBe(withoutBuildTime(portable))
      expect(opened).toContain('ship it on friday')

      await win.keyboard.press('Escape')
      const settings = settingsOf(win)
      if (!(await settings.isVisible())) {
        await win.locator('.topbar').getByRole('button', { name: 'Settings' }).click()
      }
      await settings.getByRole('button', { name: 'Shared artifacts', exact: true }).click()
      const row = settings.getByRole('listitem').filter({ hasText: ARTIFACT })
      await expect(row).toContainText('Link ·')
      await expect(row).toContainText('1 view')
      await row.getByRole('button', { name: 'Delete' }).click()
      await expect(settings.getByText(/Nothing published yet/)).toBeVisible(SLOW)

      await expect
        .poll(async () => (await fromApiHost(server, `/s/${id}/meta`)).status, SLOW)
        .toBeGreaterThanOrEqual(404)
      expect([404, 410]).toContain((await fromApiHost(server, `/s/${id}/blob`)).status)
    } finally {
      await app.close()
      await server.stop()
    }
  })
})
