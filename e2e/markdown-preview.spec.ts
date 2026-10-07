import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'
import { _electron as electron, expect, test } from './test'

function boxesIntersect(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  )
}

test('a Markdown file can be previewed and switched back to its source', async () => {
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  mkdirSync(home, { recursive: true })
  writeFileSync(
    join(home, 'DATABASE.md'),
    '# Databases\n\n| Field | Value |\n|---|---|\n| Port | 5433 |\n',
  )

  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({ ...launch, env: { ...launch.env, HOME: home } })
  try {
    const win = await app.firstWindow()
    await openWorkspace(win)
    await win.locator('.topbar').getByRole('button', { name: 'Files', exact: true }).click()
    await win.locator('.file-row').filter({ hasText: 'DATABASE.md' }).click()
    await expect(win.locator('.monaco-editor').first()).toBeVisible({ timeout: 15_000 })

    await win.getByRole('button', { name: 'Preview Markdown' }).click()
    const preview = win.locator('.markdown-preview')
    await expect(preview.getByRole('heading', { name: 'Databases' })).toBeVisible()
    await expect(preview.getByRole('cell', { name: '5433' })).toBeVisible()

    const heading = await preview.getByRole('heading', { name: 'Databases' }).boundingBox()
    if (!heading) throw new Error('the heading is not laid out')
    const y = heading.y + heading.height / 2
    await win.mouse.move(heading.x + 2, y)
    await win.mouse.down()
    await win.mouse.move(heading.x + heading.width - 2, y, { steps: 8 })
    await win.mouse.up()
    await expect
      .poll(() => win.evaluate(() => window.getSelection()?.toString() ?? ''))
      .toContain('Databases')

    await win.getByRole('button', { name: 'Edit Markdown source' }).click()
    await expect(preview).toHaveCount(0)
    await expect(win.locator('.monaco-editor').first()).toBeVisible()
  } finally {
    await app.close()
  }
})

test('Markdown language notice buttons do not overlap preview and send controls', async () => {
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'README.md'), '# Hello\n\nMarkdown body\n')

  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({ ...launch, env: { ...launch.env, HOME: home } })
  try {
    const win = await app.firstWindow()
    await openWorkspace(win)
    await win.locator('.topbar').getByRole('button', { name: 'Files', exact: true }).click()
    await win.locator('.file-row').filter({ hasText: 'README.md' }).click()
    await expect(win.locator('.monaco-editor').first()).toBeVisible({ timeout: 15_000 })

    const notice = win.getByRole('status', { name: 'Language features' })
    await expect(notice).toContainText('lsp-marksman adds language features for .md files.', {
      timeout: 15_000,
    })

    await win.getByRole('button', { name: 'Preview Markdown' }).click()
    const install = notice.getByRole('button', { name: 'Install' })
    const no = notice.getByRole('button', { name: 'No' })
    const mode = win.locator('.editor-mode:visible')
    const send = win.locator('.editor-send:visible')
    await expect(install).toBeVisible()
    await expect(no).toBeVisible()
    await expect(mode).toBeVisible()
    await expect(send).toBeVisible()

    const installBox = await install.boundingBox()
    const noBox = await no.boundingBox()
    const modeBox = await mode.boundingBox()
    const sendBox = await send.boundingBox()
    if (!installBox || !noBox || !modeBox || !sendBox) {
      throw new Error('expected markdown notice and controls to have layout boxes')
    }
    expect(boxesIntersect(installBox, modeBox)).toBe(false)
    expect(boxesIntersect(installBox, sendBox)).toBe(false)
    expect(boxesIntersect(noBox, modeBox)).toBe(false)
    expect(boxesIntersect(noBox, sendBox)).toBe(false)
  } finally {
    await app.close()
  }
})
