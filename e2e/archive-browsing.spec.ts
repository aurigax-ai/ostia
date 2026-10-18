import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { XzCompressor } from '@napi-rs/lzma'
import { tarOf, zerosDeflated, zipOf } from '../test/fixtures/archives/archives'
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

async function xz(bytes: Uint8Array): Promise<Buffer> {
  const compressor = new XzCompressor({ preset: 0 })
  return Buffer.concat([compressor.update(bytes), await compressor.finish()])
}

async function homeWithTars(dataHome: string): Promise<string> {
  const home = join(dataHome, 'home')
  mkdirSync(home, { recursive: true })
  const packed = tarOf(
    [
      { name: 'docs/readme.txt', data: 'packed readme' },
      { name: 'passwd', type: '2', link: '../../etc/passwd' },
    ],
    false,
  )
  writeFileSync(join(home, 'bundle.tar.xz'), await xz(packed))
  writeFileSync(
    join(home, 'bundle.tar.bz2'),
    execFileSync('bzip2', ['-9', '-c'], { input: packed }),
  )
  return home
}

for (const name of ['bundle.tar.xz', 'bundle.tar.bz2']) {
  test(`a ${name.slice(7)} expands through the archives extension and its entries open read-only`, async () => {
    const dataHome = freshDataHome()
    const home = await homeWithTars(dataHome)
    const launch = isolatedLaunch(dataHome)
    const app = await electron.launch({ ...launch, env: { ...launch.env, HOME: home } })
    try {
      const win = await app.firstWindow()
      await openWorkspace(win)
      await win.locator('.topbar').getByRole('button', { name: 'Files', exact: true }).click()
      const archive = win.locator('.file-row').filter({ hasText: name })
      await expect(archive).toHaveAttribute('aria-expanded', 'false')
      await archive.click()
      await expect(archive).toHaveAttribute('aria-expanded', 'true')
      await expect(
        win.locator('.file-row').filter({ hasText: 'passwd → ../../etc/passwd' }),
      ).toBeVisible({ timeout: 15_000 })
      const docs = win.locator('.file-row').filter({ hasText: /^docs$/ })
      await docs.focus()
      await win.keyboard.press('ArrowRight')
      await win.locator('.file-row').filter({ hasText: 'readme.txt' }).click()
      await expect(win.locator('.monaco-editor:visible .view-lines')).toContainText(
        'packed readme',
        { timeout: 15_000 },
      )
      expect(
        readdirSync(home)
          .filter((entry) => !entry.startsWith('.'))
          .sort(),
      ).toEqual(['bundle.tar.bz2', 'bundle.tar.xz'])
    } finally {
      await app.close()
    }
  })
}

test('with the archives extension disabled a .tar.xz and a .tar.bz2 are plain file rows', async () => {
  const dataHome = freshDataHome()
  const home = await homeWithTars(dataHome)
  mkdirSync(join(dataHome, 'userData'), { recursive: true })
  writeFileSync(
    join(dataHome, 'userData', 'extensions.json'),
    JSON.stringify({ archives: { enabled: false, approved: [] } }),
  )
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({ ...launch, env: { ...launch.env, HOME: home } })
  try {
    const win = await app.firstWindow()
    await openWorkspace(win)
    await win.locator('.topbar').getByRole('button', { name: 'Files', exact: true }).click()
    for (const name of ['bundle.tar.xz', 'bundle.tar.bz2']) {
      const row = win.locator('.file-row').filter({ hasText: name })
      await expect(row).toBeVisible()
      await expect(row).not.toHaveAttribute('aria-expanded')
    }
  } finally {
    await app.close()
  }
})
