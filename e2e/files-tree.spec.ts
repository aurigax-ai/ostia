import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { PRODUCT_NAME } from '../src/shared/product'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'

const fixture = join(__dirname, '..', 'test', 'fixtures', 'extensions-e2e', 'icons')

function seedProject(home: string): void {
  mkdirSync(join(home, 'src', 'main', 'java'), { recursive: true })
  writeFileSync(join(home, 'src', 'main', 'java', 'App.java'), 'class App {}\n')
  writeFileSync(join(home, 'package.json'), '{}\n')
  writeFileSync(join(home, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  writeFileSync(join(home, 'index.ts'), 'export {}\n')
  writeFileSync(join(home, 'index.test.ts'), 'export {}\n')
  writeFileSync(join(home, 'secret.txt'), 'shh\n')
}

test('a VS Code icon theme from an extension, compact folders, nesting and hiding in the Files tree', async () => {
  test.setTimeout(90_000)
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  seedProject(home)
  const launch = isolatedLaunch(dataHome)
  cpSync(fixture, join(launch.env.XDG_CONFIG_HOME, PRODUCT_NAME, 'extensions', 'fixture-icons'), {
    recursive: true,
  })
  const app = await electron.launch({ ...launch, env: { ...launch.env, HOME: home } })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')

    const approval = win.getByRole('dialog').filter({ hasText: 'Fixture Icons' })
    await expect(approval).toBeVisible({ timeout: 15_000 })
    await approval.getByRole('button', { name: 'Approve and enable' }).click()
    await expect(approval).toBeHidden()

    await openWorkspace(win)
    await win.locator('.topbar').getByRole('button', { name: 'Files', exact: true }).click()
    const tree = win.locator('.file-tree')
    const row = (name: string) => tree.getByRole('button', { name, exact: true })

    await expect(row('package.json')).toBeVisible({ timeout: 15_000 })
    await expect(row('package.json').locator('img')).toHaveCount(0)

    await win.locator('.topbar').getByRole('button', { name: 'Settings' }).click()
    const settings = win.getByRole('region', { name: 'Settings' })
    await settings.getByRole('button', { name: 'Files', exact: true }).click()
    await settings.getByRole('combobox', { name: 'File icon theme' }).click()
    await win.getByRole('option', { name: 'Fixture Icons' }).click()
    await win.keyboard.press('Escape')
    await expect(settings).toHaveCount(0)

    const icon = (name: string) => row(name).locator('img.file-icon-theme')
    await expect(icon('package.json')).toHaveAttribute('src', /^data:image\/png;base64,/, {
      timeout: 15_000,
    })
    await expect(icon('index.ts')).toHaveAttribute('src', /^data:image\/svg\+xml;base64,/)
    const srcFolderIcon = await icon('src').getAttribute('src')

    await expect(row('pnpm-lock.yaml')).toHaveCount(0)
    await expect(row('index.test.ts')).toHaveCount(0)
    await row('index.ts').locator('.file-twisty').click()
    await expect(row('index.test.ts')).toBeVisible()
    const testIcon = await icon('index.test.ts').getAttribute('src')
    expect(testIcon).not.toBe(await icon('index.ts').getAttribute('src'))

    await row('src').click()
    await expect(row('src/main/java')).toBeVisible({ timeout: 15_000 })
    await expect(row('App.java')).toBeVisible()
    await expect(row('main')).toHaveCount(0)
    expect(await icon('src/main/java').getAttribute('src')).not.toBe(srcFolderIcon)

    await row('secret.txt').click({ button: 'right' })
    await win.getByRole('menuitem', { name: 'Hide in tree' }).click()
    await expect(row('secret.txt')).toHaveCount(0)
    await win.locator('.files-head').getByRole('button', { name: 'Show hidden files' }).click()
    await expect(row('secret.txt')).toHaveClass(/excluded/)
  } finally {
    await app.close()
  }
})
