import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PRODUCT_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/product'
import { MARKETPLACE_MANIFEST_FILE } from '@aurigax-ai/ostia-extension-sdk/manifest/marketplaceManifest'
import { buildSync } from 'esbuild'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'
import { type Locator, type Page, _electron as electron, expect, test } from './test'

const fixture = join(__dirname, '..', 'test', 'fixtures', 'extensions-e2e', 'hello')

const LISTED = { name: 'E2E marketplace', extensions: ['extensions/hello'] }

function marketplaceRepo(dataHome: string, manifest: object = LISTED): string {
  const repo = join(dataHome, 'marketplace-repo')
  const dir = join(repo, 'extensions', 'hello')
  mkdirSync(dir, { recursive: true })
  for (const file of ['panel.html', 'card.html', 'ostia.json']) {
    copyFileSync(join(fixture, file), join(dir, file))
  }
  buildSync({
    entryPoints: [join(fixture, 'main.js')],
    outfile: join(dir, 'main.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'warning',
  })
  writeFileSync(join(repo, MARKETPLACE_MANIFEST_FILE), JSON.stringify(manifest))
  git(repo, 'init', '-b', 'main')
  commitAll(repo, 'marketplace')
  return repo
}

function git(repo: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=E2E', '-c', 'user.email=e2e@example.com', ...args], {
    cwd: repo,
    stdio: 'ignore',
  })
}

function commitAll(repo: string, message: string): void {
  git(repo, 'add', '-A')
  git(repo, 'commit', '-m', message)
}

async function openSettingsPage(win: Page, page: string): Promise<Locator> {
  const settings = win.getByRole('region', { name: 'Settings', exact: true })
  if (!(await settings.isVisible())) {
    await win.keyboard.press('Control+,')
    await expect(settings).toBeVisible({ timeout: 10_000 })
  }
  await settings.getByRole('navigation').getByRole('button', { name: page, exact: true }).click()
  return settings
}

test('installs from a git marketplace, is approved, configured and updated', async () => {
  test.setTimeout(90_000)
  const dataHome = freshDataHome()
  const repo = marketplaceRepo(dataHome)
  const launch = isolatedLaunch(dataHome)
  const installedManifest = join(
    launch.env.XDG_CONFIG_HOME,
    PRODUCT_NAME,
    'extensions',
    'hello',
    'ostia.json',
  )
  const app = await electron.launch(launch)
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)

    let settings = await openSettingsPage(win, 'Extensions')
    await settings.getByRole('textbox', { name: 'Marketplace repository' }).fill(repo)
    await settings.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(settings.getByRole('button', { name: 'Refresh E2E marketplace' })).toBeVisible({
      timeout: 15_000,
    })
    await settings.getByRole('button', { name: 'Browse', exact: true }).click()
    const browse = win.getByRole('dialog', { name: 'Browse extensions' })
    const card = browse
      .getByRole('list', { name: 'Extensions in your marketplaces' })
      .getByRole('listitem', { name: 'Hello' })
    await expect(card).toBeVisible({ timeout: 15_000 })

    await browse
      .getByTestId('extension-page')
      .getByRole('button', { name: 'Install', exact: true })
      .click()
    const approval = win.getByRole('dialog', { name: 'Allow the extension “Hello”?' })
    await expect(approval).toBeVisible({ timeout: 15_000 })
    expect(existsSync(installedManifest)).toBe(true)
    const waiting = win.getByText('Hello is installed and waits for your approval.')
    await expect(waiting).toBeVisible()
    await approval.getByRole('button', { name: 'Approve and enable' }).click()
    await expect(approval).toBeHidden()
    await expect(waiting).toHaveCount(0)
    await expect(card.getByText('Installed', { exact: true })).toBeVisible()
    await browse.getByRole('button', { name: 'Close' }).click()
    await expect(browse).toBeHidden()

    const installed = settings.getByRole('list', { name: 'Installed extensions' })
    const hello = installed.getByRole('listitem', { name: 'Hello' })
    await expect(hello.getByRole('switch')).toBeChecked()
    await hello.getByRole('button', { name: 'Settings of Hello' }).click()
    const details = settings.getByRole('region', { name: 'Settings of Hello' })
    const greeting = details.getByRole('textbox', { name: 'Greeting' })
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

    const manifestPath = join(repo, 'extensions', 'hello', 'ostia.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: '0.2.0' }))
    commitAll(repo, 'hello 0.2.0')

    settings = await openSettingsPage(win, 'Extensions')
    await settings.getByRole('button', { name: 'Refresh E2E marketplace' }).click()
    await hello.getByRole('button', { name: 'Update to 0.2.0' }).click()
    await expect
      .poll(() => JSON.parse(readFileSync(installedManifest, 'utf8')).version, {
        timeout: 15_000,
      })
      .toBe('0.2.0')

    await expect(hello).toContainText('0.2.0 · From E2E marketplace')
    await expect(details.getByRole('textbox', { name: 'Greeting' })).toHaveValue('hey')
  } finally {
    await app.close()
  }
})
