import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildSync } from 'esbuild'
import { MARKETPLACE_MANIFEST_FILE } from '../src/shared/marketplace'
import { PRODUCT_NAME } from '../src/shared/product'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'
import { type Locator, type Page, _electron as electron, expect, test } from './test'

const fixture = join(__dirname, '..', 'test', 'fixtures', 'extensions-e2e', 'hello')

const INSTALL_CODE = 'abcdefghijklmnopqrstuvwx23'
const LISTED = { name: 'E2E marketplace', extensions: ['extensions/hello'] }
const UNLISTED = {
  name: 'E2E marketplace',
  extensions: [],
  unlisted: [{ path: 'extensions/hello', code: INSTALL_CODE }],
}

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
  const settings = win.getByRole('region', { name: 'Settings' })
  if (!(await settings.isVisible())) {
    await win.keyboard.press('Control+,')
    await expect(settings).toBeVisible({ timeout: 10_000 })
  }
  await settings.getByRole('navigation').getByRole('button', { name: page, exact: true }).click()
  return settings
}

test('installs from a git marketplace, is approved, configured, updated and uninstalled', async () => {
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

    let settings = await openSettingsPage(win, 'Browse extensions')
    const browse = settings.getByRole('region', { name: 'Browse extensions' })
    await browse.getByRole('textbox', { name: 'Marketplace repository' }).fill(repo)
    await browse.getByRole('button', { name: 'Add', exact: true }).click()
    const results = browse.getByRole('list', { name: 'Extensions in your marketplaces' })
    const row = results.getByRole('listitem', { name: 'Hello' })
    await expect(row).toBeVisible({ timeout: 15_000 })
    await browse.getByRole('searchbox', { name: 'Search extensions' }).fill('fixture')
    await expect(results.getByRole('listitem')).toHaveCount(1)

    await row.getByRole('button', { name: 'Install', exact: true }).click()
    const approval = win.getByRole('dialog').filter({ hasText: 'Hello' })
    await expect(approval).toBeVisible({ timeout: 15_000 })
    expect(existsSync(installedManifest)).toBe(true)
    const waiting = win.getByText('Hello is installed and waits for your approval.')
    await expect(waiting).toBeVisible()
    await approval.getByRole('button', { name: 'Approve and enable' }).click()
    await expect(approval).toBeHidden()
    await expect(waiting).toHaveCount(0)
    await expect(row.getByText('Installed', { exact: true })).toBeVisible()

    settings = await openSettingsPage(win, 'Extensions')
    const installed = settings.getByRole('list', { name: 'Installed extensions' })
    const hello = installed.getByRole('listitem', { name: 'Hello' })
    await expect(hello.getByRole('switch')).toBeChecked()
    await expect(hello.getByText('Enabled', { exact: true })).toBeVisible()
    await expect(installed.getByRole('textbox')).toHaveCount(0)
    await hello.getByRole('button', { name: 'Hello' }).click()
    const details = settings.getByRole('region', { name: 'Hello', exact: true })
    await expect(details.getByText('From E2E marketplace', { exact: false })).toBeVisible()
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

    settings = await openSettingsPage(win, 'Browse extensions')
    await browse.getByRole('button', { name: 'Refresh E2E marketplace' }).click()
    await browse
      .getByRole('group', { name: 'Show' })
      .getByRole('button', { name: 'Updates' })
      .click()
    await expect(row.getByText('Update available')).toBeVisible({ timeout: 15_000 })
    await row.getByRole('button', { name: 'Hello' }).click()
    const offer = browse.getByRole('region', { name: 'Details' })
    await expect(offer).toContainText('Installed 0.1.0, offered 0.2.0')
    await row.getByRole('button', { name: 'Update', exact: true }).click()
    await expect
      .poll(() => JSON.parse(readFileSync(installedManifest, 'utf8')).version, {
        timeout: 15_000,
      })
      .toBe('0.2.0')
    await expect(results.getByRole('listitem')).toHaveCount(0)

    settings = await openSettingsPage(win, 'Extensions')
    await installed
      .getByRole('listitem', { name: 'Hello' })
      .getByRole('button', { name: 'Hello' })
      .click()
    await expect(details).toContainText('0.2.0')
    await expect(details.getByRole('textbox', { name: 'Greeting' })).toHaveValue('hey')
    await details.getByRole('button', { name: 'Uninstall' }).click()
    const confirm = win.getByRole('alertdialog')
    await confirm.getByRole('button', { name: 'Uninstall' }).click()
    await expect(installed.getByRole('listitem', { name: 'Hello' })).toHaveCount(0, {
      timeout: 15_000,
    })
    expect(existsSync(installedManifest)).toBe(false)

    await openSettingsPage(win, 'Browse extensions')
    await browse
      .getByRole('group', { name: 'Show' })
      .getByRole('button', { name: 'All', exact: true })
      .click()
    await expect(row.getByRole('button', { name: 'Install', exact: true })).toBeVisible()
  } finally {
    await app.close()
  }
})

test('an unlisted extension stays out of Settings until its install code is typed', async () => {
  const dataHome = freshDataHome()
  const repo = marketplaceRepo(dataHome, UNLISTED)
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

    const settings = await openSettingsPage(win, 'Browse extensions')
    await settings.getByRole('textbox', { name: 'Marketplace repository' }).fill(repo)
    await settings.getByRole('button', { name: 'Add', exact: true }).click()
    const card = settings.getByRole('listitem', { name: 'E2E marketplace' })
    await expect(card.getByText('This marketplace lists no extensions.')).toBeVisible({
      timeout: 15_000,
    })
    await expect(settings.getByRole('listitem', { name: 'Hello' })).toHaveCount(0)

    const code = card.getByRole('textbox', { name: 'Install code for E2E marketplace' })
    await code.fill('hello')
    await code.press('Enter')
    await expect(
      settings.getByText('No unlisted extension in this marketplace has this install code.'),
    ).toBeVisible()
    expect(existsSync(installedManifest)).toBe(false)

    await code.fill(INSTALL_CODE)
    await code.press('Enter')
    const approval = win.getByRole('dialog').filter({ hasText: 'Hello' })
    await expect(approval).toBeVisible({ timeout: 15_000 })
    expect(existsSync(installedManifest)).toBe(true)
    await approval.getByRole('button', { name: 'Approve and enable' }).click()
    const row = settings
      .getByRole('list', { name: 'Extensions in your marketplaces' })
      .getByRole('listitem', { name: 'Hello' })
    await expect(row.getByText('Installed', { exact: true })).toBeVisible()
  } finally {
    await app.close()
  }
})
