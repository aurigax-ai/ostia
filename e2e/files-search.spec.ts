import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { _electron as electron, expect, test } from './test'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'

test('the Files panel searches folder names, file names and text with the bundled ripgrep', async () => {
  test.setTimeout(90_000)
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  mkdirSync(join(home, 'src', 'notes'), { recursive: true })
  writeFileSync(join(home, 'src', 'notes', 'todo.md'), 'first line\nfind the needle here\n')
  writeFileSync(join(home, 'index.ts'), 'export const haystack = 1\n')
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({ ...launch, env: { ...launch.env, HOME: home } })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await win.locator('.topbar').getByRole('button', { name: 'Files', exact: true }).click()
    await expect(win.locator('.file-tree').getByRole('button', { name: 'index.ts' })).toBeVisible({
      timeout: 15_000,
    })

    const box = win.getByRole('textbox', { name: 'Search files' })
    await box.fill('needle')
    const text = win.getByRole('region', { name: 'Text' })
    await expect(text).toContainText('find the needle here', { timeout: 15_000 })
    await expect(text).toContainText('src/notes/todo.md')

    await box.fill('notes/')
    const names = win.getByRole('region', { name: 'Files and folders' })
    await expect(names.getByRole('button')).toHaveText(['src/notes'], { timeout: 15_000 })

    await names.getByRole('button', { name: 'src/notes' }).click()
    await expect(box).toHaveValue('')
    await expect(win.locator('.file-tree').getByRole('button', { name: 'todo.md' })).toBeVisible()

    await box.fill('needle')
    await text.getByRole('button', { name: /find the needle here/ }).click()
    await expect(win.getByRole('tab', { name: /todo\.md/ })).toBeVisible({ timeout: 15_000 })
  } finally {
    await app.close()
  }
})
