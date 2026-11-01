import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { PRODUCT_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/product'
import { buildSync } from 'esbuild'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'
import { type ElectronApplication, _electron as electron, expect, test } from './test'

const fixture = join(__dirname, '..', 'test', 'fixtures', 'extensions-e2e', 'hello')

function installWhileRunning(configHome: string): void {
  const dir = join(configHome, PRODUCT_NAME, 'extensions', 'hello')
  mkdirSync(dir, { recursive: true })
  copyFileSync(join(fixture, 'panel.html'), join(dir, 'panel.html'))
  copyFileSync(join(fixture, 'card.html'), join(dir, 'card.html'))
  buildSync({
    entryPoints: [join(fixture, 'main.js')],
    outfile: join(dir, 'main.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'warning',
  })
  copyFileSync(join(fixture, 'ostia.json'), join(dir, 'ostia.json'))
}

function panelUrl(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ webContents }) => {
    const guest = webContents
      .getAllWebContents()
      .find((wc) => wc.getType() === 'webview' && wc.getURL().startsWith('file://'))
    return guest ? guest.getURL() : ''
  })
}

test('an extension installed while ostia runs asks for approval, then moves its panel between its pages', async () => {
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  mkdirSync(home, { recursive: true })
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({ ...launch, env: { ...launch.env, HOME: home } })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)

    installWhileRunning(launch.env.XDG_CONFIG_HOME)
    const approval = win.getByRole('dialog').filter({ hasText: 'Hello' })
    await expect(approval).toBeVisible({ timeout: 15_000 })
    await approval.getByRole('button', { name: 'Approve and enable' }).click()
    await expect(approval).toBeHidden()

    const term = win.locator('.ghostty-host').first()
    await term.click()
    await win.keyboard.type('ostia hello chip')
    await win.keyboard.press('Enter')
    const chip = win.locator('.pane-header .pane-chip').filter({ hasText: 'hello chip' })
    await expect(chip).toBeVisible({ timeout: 15_000 })

    await chip.click()
    await expect(win.locator('webview.extension-webview')).toHaveCount(1, { timeout: 15_000 })
    await expect.poll(() => panelUrl(app), { timeout: 15_000 }).toMatch(/\/panel\.html$/)

    await term.click()
    await win.keyboard.type('ostia hello card')
    await win.keyboard.press('Enter')
    await expect.poll(() => panelUrl(app), { timeout: 15_000 }).toMatch(/\/card\.html$/)
    await expect(win.locator('webview.extension-webview')).toHaveCount(1)
  } finally {
    await app.close()
  }
})
