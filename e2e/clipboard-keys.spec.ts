import { _electron as electron, expect, test } from '@playwright/test'
import { chords, isMac } from './chords'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { openWorkspace } from './helpers'

async function launch(clipboardKeys: 'shift' | 'smart') {
  const dataHome = freshDataHome()
  seedSettings(dataHome, { ...DOM_RENDERER_SETTINGS, terminal: { clipboardKeys } })
  const app = await electron.launch(isolatedLaunch(dataHome))
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await openWorkspace(win)
  await expect(win.locator('.xterm-rows')).toContainText(/[❯$%#]/, { timeout: 15_000 })
  await app.evaluate(({ clipboard }) => clipboard.writeText('echo pasted_$((6*7))'))
  await win.locator('.xterm').first().click()
  return { app, win }
}

test('smart copy/paste keys paste with Ctrl+V', async () => {
  test.skip(isMac, 'smart Ctrl+C and Ctrl+V do not exist on macOS, which uses the Cmd keys')
  const { app, win } = await launch('smart')
  try {
    await win.keyboard.press('Control+v')
    await expect(win.locator('.xterm-rows')).toContainText('echo pasted_')
    await win.keyboard.press('Enter')
    await expect(win.locator('.xterm-rows')).toContainText('pasted_42', { timeout: 10_000 })
  } finally {
    await app.close()
  }
})

test('the paste chord pastes in the default mode, and Ctrl+V goes to the shell', async () => {
  const { app, win } = await launch('shift')
  try {
    await win.keyboard.press('Control+v')
    await win.keyboard.press('x')
    await expect(win.locator('.xterm-rows')).not.toContainText('pasted_')
    await win.keyboard.press('Control+c')
    await win.keyboard.press(chords.paste)
    await expect(win.locator('.xterm-rows')).toContainText('echo pasted_')
    await win.keyboard.press('Enter')
    await expect(win.locator('.xterm-rows')).toContainText('pasted_42', { timeout: 10_000 })
  } finally {
    await app.close()
  }
})
