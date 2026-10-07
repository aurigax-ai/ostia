import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'
import { _electron as electron, expect, test } from './test'

test('Ctrl+click on a file path in terminal output opens it in the editor at that line', async () => {
  test.setTimeout(60_000)
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  mkdirSync(join(home, 'notes'), { recursive: true })
  const source = Array.from({ length: 40 }, (_, i) => `const line${i + 1} = ${i + 1}`).join('\n')
  writeFileSync(join(home, 'notes', 'app.ts'), `${source}\n`)

  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({ ...launch, env: { ...launch.env, HOME: home } })
  try {
    const win = await app.firstWindow()
    await openWorkspace(win)
    await win.locator('.xterm').first().click()
    await win.keyboard.type("clear; printf 'error at notes/app.ts:27:7\\n'")
    await win.keyboard.press('Enter')

    const rows = win.locator('.xterm-rows').first()
    const row = rows.locator('div', { hasText: /^error at notes\/app\.ts:27:7\s*$/ }).first()
    await expect(row).toHaveCount(1, { timeout: 15_000 })
    await expect(
      row
        .locator('xpath=following-sibling::div')
        .filter({ hasText: /[❯$%#]/ })
        .first(),
    ).toBeAttached({ timeout: 15_000 })
    const target = await row.evaluate((el) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.textContent?.indexOf('app.ts') ?? -1
        if (at < 0) continue
        const range = document.createRange()
        range.setStart(node, at)
        range.setEnd(node, at + 1)
        const rect = range.getBoundingClientRect()
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
      }
      return null
    })
    if (!target) throw new Error('path text not found in the row')

    await win.mouse.move(target.x, target.y)
    await win.keyboard.down('Control')
    await win.mouse.click(target.x, target.y)
    await win.keyboard.up('Control')

    await expect(win.locator('.monaco-editor').first()).toBeVisible({ timeout: 15_000 })
    await expect(win.locator('.pane-header .title').filter({ hasText: 'app.ts' })).toBeVisible()
    await expect(win.locator('.monaco-editor .active-line-number').first()).toHaveText('27', {
      timeout: 10_000,
    })
  } finally {
    await app.close()
  }
})
