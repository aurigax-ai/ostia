import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { XzCompressor } from '@napi-rs/lzma'
import { tarOf, zerosDeflated, zipOf } from '../test/fixtures/archives/archives'
import { workbook } from '../test/fixtures/office/workbooks'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'
import { _electron as electron, expect, test } from './test'
import { viewerGuestText } from './viewerGuest'

const MIB = 1024 * 1024

const FIXTURES = join(__dirname, '..', 'test', 'fixtures', 'archives')
const BZIP2_FIXTURE = join(FIXTURES, 'bz2-note.tar.bz2')
const SEVEN_ZIP_FIXTURE = join(FIXTURES, '7z', 'note.7z')

async function xz(bytes: Uint8Array): Promise<Buffer> {
  const compressor = new XzCompressor({ preset: 0 })
  return Buffer.concat([compressor.update(bytes), await compressor.finish()])
}

const PACKED_ROWS = [
  { name: 'bundle.tar.xz', file: 'xz-note.txt', text: 'packed in xz' },
  { name: 'bundle.tar.bz2', file: 'bz2-note.txt', text: 'packed in bz2' },
  { name: 'bundle.7z', file: '7z-note.txt', text: 'packed in 7z' },
]

test('a zip, a tar.xz, a tar.bz2 and a 7z expand in the Files panel, their entries open read-only without extracting, and turning the archives extension off makes them plain files', async () => {
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  mkdirSync(home, { recursive: true })
  writeFileSync(
    join(home, 'bundle.tar.xz'),
    await xz(tarOf([{ name: 'xz-note.txt', data: 'packed in xz' }], false)),
  )
  copyFileSync(BZIP2_FIXTURE, join(home, 'bundle.tar.bz2'))
  copyFileSync(SEVEN_ZIP_FIXTURE, join(home, 'bundle.7z'))
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
    await expect(
      win.getByText('This entry unpacks to more than it says, so it is not shown.'),
    ).toBeVisible({ timeout: 15_000 })

    for (const packed of PACKED_ROWS) {
      const row = win.locator('.file-row').filter({ hasText: packed.name })
      await row.click()
      await expect(row).toHaveAttribute('aria-expanded', 'true')
      await win.locator('.file-row').filter({ hasText: packed.file }).click()
      await expect(win.locator('.monaco-editor:visible .view-lines')).toContainText(packed.text, {
        timeout: 15_000,
      })
    }
    expect(
      readdirSync(home)
        .filter((name) => !name.startsWith('.'))
        .sort(),
    ).toEqual(['bundle.7z', 'bundle.tar.bz2', 'bundle.tar.xz', 'bundle.zip'])

    await win.getByRole('button', { name: 'Settings', exact: true }).first().click()
    await win.getByRole('button', { name: 'Extensions', exact: true }).first().click()
    const toggle = win.getByRole('switch', { name: 'Enable Archives' })
    await toggle.click()
    await expect(toggle).not.toBeChecked()
    await win.keyboard.press('Escape')
    await expect(archive).not.toHaveAttribute('aria-expanded', /.+/, { timeout: 15_000 })
    for (const packed of PACKED_ROWS) {
      const row = win.locator('.file-row').filter({ hasText: packed.name })
      await expect(row).not.toHaveAttribute('aria-expanded', /.+/, { timeout: 15_000 })
    }

    await win.getByRole('button', { name: 'Settings', exact: true }).first().click()
    await win.getByRole('button', { name: 'Extensions', exact: true }).first().click()
    await toggle.click()
    await expect(toggle).toBeChecked()
    await win.keyboard.press('Escape')
    await expect(archive).toHaveAttribute('aria-expanded', /.+/, { timeout: 15_000 })
    for (const packed of PACKED_ROWS) {
      const row = win.locator('.file-row').filter({ hasText: packed.name })
      await expect(row).toHaveAttribute('aria-expanded', /.+/, { timeout: 15_000 })
    }
  } finally {
    await app.close()
  }
})
