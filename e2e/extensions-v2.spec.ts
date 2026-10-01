import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type ElectronApplication, _electron as electron, expect, test } from '@playwright/test'
import { buildSync } from 'esbuild'
import { PRODUCT_NAME } from '../src/shared/product'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'

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
  copyFileSync(join(fixture, 'pine.json'), join(dir, 'pine.json'))
}

function panelUrl(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ webContents }) => {
    const guest = webContents
      .getAllWebContents()
      .find((wc) => wc.getType() === 'webview' && wc.getURL().startsWith('file://'))
    return guest ? guest.getURL() : ''
  })
}

test('an extension installed while pine runs asks for approval, then drives chips, settings and panel paths', async () => {
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

    const term = win.locator('.xterm').first()
    await term.click()
    await win.keyboard.type('pine hello chip')
    await win.keyboard.press('Enter')
    const chip = win.locator('.pane-header .pane-chip').filter({ hasText: 'hello chip' })
    await expect(chip).toBeVisible({ timeout: 15_000 })
    await expect(chip).toHaveClass(/tone-ok/)

    await chip.click()
    await expect(win.locator('webview.extension-webview')).toHaveCount(1, { timeout: 15_000 })
    await expect.poll(() => panelUrl(app), { timeout: 15_000 }).toMatch(/\/panel\.html$/)

    await term.click()
    await win.keyboard.type('pine hello card')
    await win.keyboard.press('Enter')
    await expect.poll(() => panelUrl(app), { timeout: 15_000 }).toMatch(/\/card\.html$/)
    await expect(win.locator('webview.extension-webview')).toHaveCount(1)

    await win.keyboard.press('Control+,')
    const settings = win.getByRole('region', { name: 'Settings' })
    await expect(settings).toBeVisible({ timeout: 10_000 })
    await settings.getByRole('button', { name: 'Plugins', exact: true }).click()
    const greeting = settings.getByRole('textbox', { name: 'Greeting' })
    await expect(greeting).toHaveValue('hello')
    await greeting.fill('hey')
    await greeting.press('Enter')
    const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
    const savedGreeting = (): unknown => {
      try {
        const saved = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8'))
        return saved.extensionSettings?.hello?.greeting ?? null
      } catch {
        return null
      }
    }
    await expect.poll(savedGreeting, { timeout: 10_000 }).toBe('hey')
    await win.keyboard.press('Escape')
    await expect(settings).toBeHidden()

    await term.click()
    await win.keyboard.type('pine hello greet e2e')
    await win.keyboard.press('Enter')
    await expect(win.locator('.ext-item').filter({ hasText: 'hey e2e' })).toBeVisible({
      timeout: 15_000,
    })
  } finally {
    await app.close()
  }
})

test('an extension whose manifest turns invalid while pine runs is dropped with its pane chips', async () => {
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
    await approval.getByRole('button', { name: 'Approve and enable' }).click({ timeout: 15_000 })

    await win.locator('.xterm').first().click()
    await win.keyboard.type('pine hello chip')
    await win.keyboard.press('Enter')
    const chip = win.locator('.pane-chip').filter({ hasText: 'hello chip' })
    await expect(chip).toBeVisible({ timeout: 15_000 })

    const manifest = join(
      launch.env.XDG_CONFIG_HOME,
      PRODUCT_NAME,
      'extensions',
      'hello',
      'pine.json',
    )
    writeFileSync(manifest, '{ "broken": ')
    await expect(chip).toBeHidden({ timeout: 15_000 })
  } finally {
    await app.close()
  }
})
