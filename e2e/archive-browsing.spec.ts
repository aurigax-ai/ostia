import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zerosDeflated, zipOf } from '../test/fixtures/archives/archives'
import { workbook } from '../test/fixtures/office/workbooks'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'
import { _electron as electron, expect, test } from './test'
import { viewerGuestText } from './viewerGuest'

const MIB = 1024 * 1024

test('a zip expands in the Files panel and its entries open read-only without extracting', async () => {
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  mkdirSync(home, { recursive: true })
  writeFileSync(
    join(home, 'bundle.zip'),
    zipOf([
      { name: 'docs/readme.txt', data: 'packed readme' },
      { name: 'docs/sheet.xlsx', data: workbook({ Data: [['from the archive']] }) },
      { name: 'bomb.bin', deflated: zerosDeflated(64 * MIB), size: 1024 },
      { name: 'shadow', data: '/etc/shadow', mode: 0o120777 },
      { name: 'secret.txt', data: 'x', flags: 0x0801 },
    ]),
  )
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({ ...launch, env: { ...launch.env, HOME: home } })
  try {
    const win = await app.firstWindow()
    await openWorkspace(win)
    await win.locator('.topbar').getByRole('button', { name: 'Files', exact: true }).click()
    const archive = win.locator('.file-row').filter({ hasText: 'bundle.zip' })
    await expect(archive).toHaveAttribute('aria-expanded', 'false')
    await archive.click()
    await expect(archive).toHaveAttribute('aria-expanded', 'true')
    const docs = win.locator('.file-row').filter({ hasText: /^docs$/ })
    await expect(docs).toBeVisible()
    await docs.focus()
    await win.keyboard.press('ArrowRight')
    await expect(docs).toHaveAttribute('aria-expanded', 'true')
    await expect(win.locator('.file-row').filter({ hasText: 'shadow → /etc/shadow' })).toBeVisible()
    await expect(
      win.locator('.file-row').filter({ hasText: 'secret.txt' }).getByLabel('Encrypted'),
    ).toBeVisible()

    await win.locator('.file-row').filter({ hasText: 'readme.txt' }).click()
    const lines = win.locator('.monaco-editor:visible .view-lines')
    await expect(lines).toContainText('packed readme', { timeout: 15_000 })
    await lines.click()
    await win.keyboard.type('typed')
    await expect(lines).toHaveText('packed readme')

    await win.locator('.file-row').filter({ hasText: 'sheet.xlsx' }).click()
    await expect(win.locator('[data-testid="file-viewer"]:visible')).toHaveAttribute(
      'data-view-type',
      'office.spreadsheet',
      { timeout: 15_000 },
    )
    await expect
      .poll(() => viewerGuestText(app, { viewType: 'office.spreadsheet', name: 'sheet.xlsx' }), {
        timeout: 20_000,
      })
      .toContain('from the archive')

    await win.locator('.file-row').filter({ hasText: 'bomb.bin' }).click()
    await expect(win.locator('.editor-binary:visible')).toContainText(
      'This entry unpacks to more than it says, so it is not shown.',
      { timeout: 15_000 },
    )
    await win.locator('.file-row').filter({ hasText: 'shadow' }).click()
    await expect(win.locator('.editor-binary:visible')).toContainText(
      'This entry is a link inside the archive; it is never followed.',
    )
    expect(readdirSync(home).filter((name) => !name.startsWith('.'))).toEqual(['bundle.zip'])
  } finally {
    await app.close()
  }
})
