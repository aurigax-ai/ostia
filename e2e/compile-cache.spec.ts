import { chmodSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { freshDataHome } from './dataHome'
import { launchWindow, openWorkspace, PROMPT, quitApp } from './helpers'
import { expect, test } from './test'

function cacheFiles(folder: string): string[] {
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
}

test('the compiled-code cache is private to the human, and a damaged or foreign one is ignored', async () => {
  test.setTimeout(120_000)
  const dataHome = freshDataHome()
  const folder = join(dataHome, 'userData', 'compile-cache')

  const first = await launchWindow(dataHome)
  await openWorkspace(first.win)
  await quitApp(first.app)
  expect(statSync(folder).mode & 0o777).toBe(0o700)
  const files = cacheFiles(folder)
  expect(files.length).toBeGreaterThan(0)

  files.forEach((file, index) => {
    if (index % 2 === 0) writeFileSync(file, 'not a compiled module')
    else chmodSync(file, 0o000)
  })
  mkdirSync(join(folder, 'v0.0.0-x64-00000000-0'), { recursive: true })
  writeFileSync(join(folder, 'v0.0.0-x64-00000000-0', 'entry'), 'from another version')

  const second = await launchWindow(dataHome)
  try {
    await expect(second.win.locator('.ghostty-host').first()).toBeVisible({ timeout: 15_000 })
    await expect(second.win.locator('.terminal-text').first()).toContainText(PROMPT, {
      timeout: 15_000,
    })
  } finally {
    await quitApp(second.app)
  }
})
