import { freshDataHome, isolatedLaunch } from './dataHome'
import { emptyState, openWorkspace } from './helpers'
import { _electron as electron, expect, test } from './test'

test('bulk output reaches the screen in full, acknowledged by the renderer, and the shell stays responsive', async () => {
  const dataHome = freshDataHome()
  const app = await electron.launch(isolatedLaunch(dataHome))
  try {
    const win = await app.firstWindow()
    await expect(emptyState(win)).toBeVisible({ timeout: 15_000 })
    await app.evaluate(({ ipcMain }) => {
      const g = globalThis as { ackedChars?: number }
      g.ackedChars = 0
      ipcMain.on('pty:ack', (_e, _paneId: string, chars: number) => {
        g.ackedChars = (g.ackedChars ?? 0) + chars
      })
    })
    await openWorkspace(win)
    await win.locator('.xterm-helper-textarea').first().focus()
    await win.keyboard.type('seq 1 200000; echo flow-$((40+2))\n')
    await expect(win.locator('.xterm-rows')).toContainText('flow-42', { timeout: 60_000 })
    const acked = await app.evaluate(() => (globalThis as { ackedChars?: number }).ackedChars ?? 0)
    expect(acked).toBeGreaterThan(1_000_000)
    await win.keyboard.type('echo after-$((1+1))\n')
    await expect(win.locator('.xterm-rows')).toContainText('after-2', { timeout: 15_000 })
  } finally {
    await app.close()
  }
})
