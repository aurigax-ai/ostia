import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'

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
