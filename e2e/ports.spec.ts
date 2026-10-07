import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { type ElectronApplication, _electron as electron, expect, test } from './test'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { extensionHosts } from './extensionHosts'
import { openWorkspace } from './helpers'

const SERVER = `require('node:http')
  .createServer((_req, res) => res.end('ports e2e'))
  .listen(Number(process.argv[2]), '127.0.0.1')
`

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      probe.close(() => resolve(port))
    })
  })
}

function browserUrls(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .filter((wc) => wc.getType() === 'webview')
      .map((wc) => wc.getURL()),
  )
}

test('the ports extension puts ports and ssh chips on the pane, and a port chip opens the browser pane', async () => {
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  const bin = join(dataHome, 'bin')
  mkdirSync(home, { recursive: true })
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(dataHome, 'server.js'), SERVER)
  writeFileSync(join(bin, 'ssh'), '#!/bin/sh\nsleep 60\n')
  chmodSync(join(bin, 'ssh'), 0o755)
  const port = await freePort()

  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...launch,
    env: { ...launch.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await win.evaluate(() => window.ostia.extensions.setSetting('ports', 'portHost', '127.0.0.1'))

    const term = win.locator('.xterm').first()
    await term.click()
    await win.keyboard.type(
      `ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" ${join(dataHome, 'server.js')} ${port}`,
    )
    await win.keyboard.press('Enter')

    const portsChip = win
      .locator('.topbar-right .workspace-chips')
      .getByRole('button', { name: 'Listening ports: 1. Click to list them.' })
    await expect(portsChip).toBeVisible({ timeout: 20_000 })
    await expect(win.locator('.pane-header')).not.toContainText('Listening ports')
    await expect(
      win.locator('.pane-header').getByRole('button', { name: /Listening ports/ }),
    ).toHaveCount(0)
    await expect(win.locator('.rail-meta')).not.toContainText(`:${port}`)
    await portsChip.click()
    await win
      .getByRole('button', { name: `Open http://127.0.0.1:${port}/ in the browser pane` })
      .click()
    await expect
      .poll(() => browserUrls(app), { timeout: 15_000 })
      .toContain(`http://127.0.0.1:${port}/`)

    await win.getByRole('tablist').getByRole('tab').first().click()
    await term.click()
    await win.keyboard.press('Control+C')
    await expect(portsChip).toHaveCount(0, { timeout: 20_000 })
    await win.keyboard.type('ssh -p 2222 deploy@build-box')
    await win.keyboard.press('Enter')
    await expect(
      win.locator('.pane-header .pane-chip').filter({ hasText: 'deploy@build-box' }),
    ).toBeVisible({ timeout: 20_000 })
    expect(extensionHosts(app)).not.toContain('ports')
  } finally {
    await app.close()
  }
})
