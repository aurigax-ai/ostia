import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace, typeLineToEnd } from './helpers'
import { clickWith, linkPoint } from './terminalLinks'
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
    await typeLineToEnd(win, "clear; printf 'error at notes/app.ts:27:7\\n'")
    const target = await linkPoint(win, /^error at notes\/app\.ts:27:7\s*$/, 'app.ts')
    await clickWith(win, target, ['Control'])

    await expect(win.locator('.monaco-editor').first()).toBeVisible({ timeout: 15_000 })
    await expect(win.locator('.pane-header .title').filter({ hasText: 'app.ts' })).toBeVisible()
    await expect(win.locator('.monaco-editor .active-line-number').first()).toHaveText('27', {
      timeout: 10_000,
    })
  } finally {
    await app.close()
  }
})
