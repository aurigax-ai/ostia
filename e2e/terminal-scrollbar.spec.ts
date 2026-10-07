import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { emptyState, openWorkspace } from './helpers'
import { _electron as electron, expect, test } from './test'

test('the terminal text stops before the scrollbar and inside the pane', async () => {
  const dataHome = freshDataHome()
  seedSettings(dataHome, { ...DOM_RENDERER_SETTINGS })
  const app = await electron.launch(isolatedLaunch(dataHome))
  try {
    const win = await app.firstWindow()
    await expect(emptyState(win)).toBeVisible({ timeout: 15_000 })
    await openWorkspace(win)
    await win.locator('.xterm-helper-textarea').first().focus()
    await win.keyboard.type('seq 1 400\n')
    const bar = win.locator('.xterm-scrollable-element > .scrollbar.vertical').first()
    await expect(win.locator('.xterm-rows')).toContainText('400')
    await win.locator('.xterm-screen').first().hover()
    await win.mouse.wheel(0, -300)
    const box = async (selector: string) => {
      const b = await win.locator(selector).first().boundingBox()
      if (!b) throw new Error(`no box for ${selector}`)
      return b
    }
    const screen = await box('.xterm-screen')
    const host = await box('.xterm-host')
    const scrollbar = await bar.boundingBox()
    expect(scrollbar).not.toBeNull()
    expect(screen.x + screen.width).toBeLessThanOrEqual((scrollbar?.x ?? 0) + 0.5)
    expect(screen.y + screen.height).toBeLessThanOrEqual(host.y + host.height + 0.5)
  } finally {
    await app.close()
  }
})
