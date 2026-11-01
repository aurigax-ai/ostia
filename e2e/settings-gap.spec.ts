import { isMac } from './chords'
import { CANVAS_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { openWorkspace, runInTerminal } from './helpers'
import { _electron as electron, expect, test } from './test'

test('selecting terminal text fills the primary selection, and middle click pastes it', async () => {
  test.skip(isMac, 'the primary selection is X11 only')
  const dataHome = freshDataHome()
  seedSettings(dataHome, CANVAS_RENDERER_SETTINGS)
  const app = await electron.launch(isolatedLaunch(dataHome))
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await runInTerminal(win, 'echo ostia-primary-word')
    const rows = win.locator('.terminal-text').first()
    const line = rows.locator('div', { hasText: /^ostia-primary-word\s*$/ }).first()
    await expect(line).toBeAttached({ timeout: 15_000 })
    const box = await line.boundingBox()
    if (!box) throw new Error('no line box')
    await win.mouse.move(box.x + 2, box.y + box.height / 2)
    await win.mouse.down()
    await win.mouse.move(box.x + 120, box.y + box.height / 2, { steps: 5 })
    await win.mouse.up()
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.selection.readText()))
      .toContain('ostia')
    await expect(async () => {
      await app.evaluate(({ clipboard }) => clipboard.selection.writeText('echo from-primary'))
      await win.locator('.ghostty-host').first().click({ button: 'middle' })
      await expect(rows).toContainText('echo from-primary', { timeout: 1000 })
    }).toPass({ timeout: 15_000 })
  } finally {
    await app.close()
  }
})
