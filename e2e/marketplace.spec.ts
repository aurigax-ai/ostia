import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { buildSync } from 'esbuild'
import { MARKETPLACE_MANIFEST_FILE } from '../src/shared/marketplace'
import { PRODUCT_NAME } from '../src/shared/product'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'

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
  for (const file of ['panel.html', 'card.html', 'pine.json']) {
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
  const git = (...args: string[]): void => {
    execFileSync('git', ['-c', 'user.name=E2E', '-c', 'user.email=e2e@example.com', ...args], {
      cwd: repo,
      stdio: 'ignore',
    })
  }
  git('init', '-b', 'main')
  git('add', '-A')
  git('commit', '-m', 'marketplace')
  return repo
}

test('Settings adds a git marketplace, installs an extension after approval, and uninstalls it', async () => {
  const dataHome = freshDataHome()
  const repo = marketplaceRepo(dataHome)
  const launch = isolatedLaunch(dataHome)
  const installedManifest = join(
    launch.env.XDG_CONFIG_HOME,
    PRODUCT_NAME,
    'extensions',
    'hello',
    'pine.json',
  )
  const app = await electron.launch(launch)
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)

    await win.keyboard.press('Control+,')
    const settings = win.getByRole('region', { name: 'Settings' })
    await expect(settings).toBeVisible({ timeout: 10_000 })
    await settings.getByRole('button', { name: 'Extensions', exact: true }).click()

    await settings.getByRole('textbox', { name: 'Marketplace repository' }).fill(repo)
    await settings.getByRole('button', { name: 'Add', exact: true }).click()
    const card = settings.getByRole('listitem', { name: 'E2E marketplace' })
    await expect(card).toBeVisible({ timeout: 15_000 })

    await card.getByRole('button', { name: 'Install', exact: true }).click()
    const approval = win.getByRole('dialog').filter({ hasText: 'Hello' })
    await expect(approval).toBeVisible({ timeout: 15_000 })
    expect(existsSync(installedManifest)).toBe(true)
    await approval.getByRole('button', { name: 'Approve and enable' }).click()
    await expect(approval).toBeHidden()

    await expect(card.getByText('Installed', { exact: true })).toBeVisible()
    const installed = settings
      .getByRole('region', { name: 'Extensions' })
      .getByRole('listitem', { name: 'Hello' })
    await expect(installed.getByRole('switch')).toBeChecked()

    await installed.getByRole('button', { name: 'Uninstall' }).click()
    const confirm = win.getByRole('alertdialog')
    await confirm.getByRole('button', { name: 'Uninstall' }).click()
    await expect(installed).toHaveCount(0, { timeout: 15_000 })
    expect(existsSync(installedManifest)).toBe(false)
    await expect(card.getByRole('button', { name: 'Install', exact: true })).toBeVisible()
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
    'pine.json',
  )
  const app = await electron.launch(launch)
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)

    await win.keyboard.press('Control+,')
    const settings = win.getByRole('region', { name: 'Settings' })
    await expect(settings).toBeVisible({ timeout: 10_000 })
    await settings.getByRole('button', { name: 'Extensions', exact: true }).click()

    await settings.getByRole('textbox', { name: 'Marketplace repository' }).fill(repo)
    await settings.getByRole('button', { name: 'Add', exact: true }).click()
    const card = settings.getByRole('listitem', { name: 'E2E marketplace' })
    await expect(card.getByText('This marketplace lists no extensions.')).toBeVisible({
      timeout: 15_000,
    })
    await expect(card.getByRole('listitem', { name: 'Hello' })).toHaveCount(0)

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
    await expect(card.getByRole('listitem', { name: 'Hello' })).toBeVisible()
    await expect(card.getByText('Installed', { exact: true })).toBeVisible()
  } finally {
    await app.close()
  }
})
