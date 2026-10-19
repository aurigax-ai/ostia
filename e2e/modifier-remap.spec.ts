import { isMac } from './chords'
import { isolatedLaunch } from './dataHome'
import { changeSettings, openWorkspace } from './helpers'
import { _electron as electron, expect, test } from './test'

test('on macOS a remapped modifier key sends the bytes of the key it now stands for', async () => {
  test.skip(!isMac, 'the modifier remap is a macOS setting')
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await changeSettings(win, {
      terminal: { macOptionIsMeta: true },
      modifierRemap: { ControlRight: 'option', AltRight: 'control' },
    })
    await win.locator('.xterm').first().click()
    const rows = win.locator('.xterm-rows').first()
    await win.keyboard.type('cat -v')
    await win.keyboard.press('Enter')

    await win.keyboard.down('ControlLeft')
    await win.keyboard.press('a')
    await win.keyboard.up('ControlLeft')
    await expect(rows).toContainText('^A')

    await win.keyboard.down('ControlRight')
    await win.keyboard.press('b')
    await win.keyboard.up('ControlRight')
    await expect(rows).toContainText('^[b')

    await win.keyboard.down('AltRight')
    await win.keyboard.press('c')
    await win.keyboard.up('AltRight')
    await expect(rows).toContainText('^C')
  } finally {
    await app.close()
  }
})
