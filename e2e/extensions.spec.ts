import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { buildSync } from 'esbuild'
import { PRODUCT_NAME } from '../src/shared/product'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace, waitForPaletteSelection } from './helpers'

const fixture = join(__dirname, '..', 'test', 'fixtures', 'extensions-e2e', 'hello')

function installUserExtension(configHome: string): void {
  const dir = join(configHome, PRODUCT_NAME, 'extensions', 'hello')
  mkdirSync(dir, { recursive: true })
  copyFileSync(join(fixture, 'pine.json'), join(dir, 'pine.json'))
  copyFileSync(join(fixture, 'panel.html'), join(dir, 'panel.html'))
  buildSync({
    entryPoints: [join(fixture, 'main.js')],
    outfile: join(dir, 'main.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'warning',
  })
}

test('a user extension is approved, opens its panel from the palette, and runs a pine command', async () => {
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  mkdirSync(home, { recursive: true })
  const launch = isolatedLaunch(dataHome)
  installUserExtension(launch.env.XDG_CONFIG_HOME)
  const app = await electron.launch({ ...launch, env: { ...launch.env, HOME: home } })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')

    const approval = win.getByRole('dialog').filter({ hasText: 'Hello' })
    await expect(approval).toBeVisible({ timeout: 15_000 })
    await approval.getByRole('button', { name: 'Approve and enable' }).click()
    await expect(approval).toBeHidden()

    await openWorkspace(win)

    await win.keyboard.press('Control+Shift+P')
    await win.locator('[data-slot="command-input"]').fill('Hello: Open Panel')
    await waitForPaletteSelection(win, 'Hello: Open Panel')
    await expect(
      win.getByRole('dialog').getByText('Hello: Open Panel', { exact: true }),
    ).toBeVisible()
    await win.keyboard.press('Enter')

    await expect(win.locator('.pane-header .title').filter({ hasText: 'Hello' })).toBeVisible({
      timeout: 15_000,
    })
    await expect(win.locator('webview.extension-webview')).toHaveCount(1, { timeout: 15_000 })
    const panelText = (): Promise<string> =>
      app.evaluate(async ({ webContents }) => {
        const guest = webContents
          .getAllWebContents()
          .find((wc) => wc.getType() === 'webview' && wc.getURL().startsWith('file://'))
        return guest ? String(await guest.executeJavaScript('document.body.innerText')) : ''
      })
    await expect.poll(panelText, { timeout: 15_000 }).toContain('Hello from a file panel')

    await win.locator('.xterm').first().click()
    await win.keyboard.type('pine hello greet e2e')
    await win.keyboard.press('Enter')
    await expect(win.locator('.xterm-rows').first()).toContainText('greeted e2e', {
      timeout: 15_000,
    })
    await expect(win.locator('.ext-item').filter({ hasText: 'hello e2e' })).toBeVisible({
      timeout: 15_000,
    })
  } finally {
    await app.close()
  }
})
