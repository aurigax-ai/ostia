import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { openWorkspace } from './helpers'

async function launch(closeToTray: boolean) {
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  mkdirSync(home, { recursive: true })
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    workspaces: { ...DOM_RENDERER_SETTINGS.workspaces, closeToTray },
  })
  const launchOptions = isolatedLaunch(dataHome)
  const app = await electron.launch({ ...launchOptions, env: { ...launchOptions.env, HOME: home } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await openWorkspace(win)
  await win.locator('.xterm').first().click()
  return { app, win }
}

test('MGR-C1 closing the window with close-to-tray on hides it and the shell keeps running', async () => {
  test.setTimeout(60_000)
  const { app, win } = await launch(true)
  try {
    await win.keyboard.type('sleep 2; echo after_hide_$((40+2))')
    await win.keyboard.press('Enter')
    await win.evaluate(() => window.pine.window.close())

    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isVisible())),
      )
      .toEqual([false])

    await app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) w.show()
    })
    await expect(win.locator('.xterm-rows').first()).toContainText('after_hide_42', {
      timeout: 15_000,
    })
    expect(win.isClosed()).toBe(false)
  } finally {
    await app.close().catch(() => {})
  }
})

test('MGR-C2 closing the window with close-to-tray off quits Pine', async () => {
  test.setTimeout(60_000)
  const { app, win } = await launch(false)
  await Promise.all([app.waitForEvent('close'), win.evaluate(() => window.pine.window.close())])
})
