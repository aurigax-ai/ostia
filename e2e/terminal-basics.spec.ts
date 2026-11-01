import { isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'
import { _electron as electron, expect, test } from './test'

async function launch() {
  const app = await electron.launch(isolatedLaunch())
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  const rows = win.locator('.terminal-text').first()
  await openWorkspace(win)
  await win.locator('.ghostty-host').first().click()
  return { app, win, rows }
}

test('Ctrl+K reaches the shell as readline kill-line, and the pane shell reports a 256-color, truecolor terminal', {
  tag: '@core',
}, async () => {
  test.setTimeout(60_000)
  const { app, win, rows } = await launch()
  try {
    await win.keyboard.type('echo ostia_kk')
    await win.keyboard.press('Control+a')
    await win.keyboard.press('Control+k')
    await win.keyboard.type('echo ostia_$((20+22))_ok')
    await win.keyboard.press('Enter')
    await expect(rows).toContainText('ostia_42_ok', { timeout: 15_000 })
    await expect(rows).not.toContainText('ostia_kk')
    await expect(win.getByRole('dialog')).toHaveCount(0)
    await win.keyboard.type('echo "term=$TERM color=$COLORTERM"')
    await win.keyboard.press('Enter')
    await expect(rows).toContainText('term=xterm-256color color=truecolor', { timeout: 15_000 })
  } finally {
    await app.close()
  }
})
