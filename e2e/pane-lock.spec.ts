import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace, runInTerminal } from './helpers'
import { _electron as electron, expect, test } from './test'

test('a pane reports a local prompt only while its own shell holds the terminal', async () => {
  const app = await electron.launch(isolatedLaunch(freshDataHome()))
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    const paneId = (await win.locator('.pane-tab').first().getAttribute('data-tab-id')) ?? ''
    const local = (): Promise<boolean> =>
      win.evaluate((id) => window.ostia.pty.localPrompt(id), paneId)

    await expect.poll(local).toBe(true)

    await runInTerminal(win, 'sleep 30')
    await expect.poll(local, { timeout: 10_000 }).toBe(false)
  } finally {
    await app.close()
  }
})
