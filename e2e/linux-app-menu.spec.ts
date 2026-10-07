import { _electron as electron, expect, test } from './test'
import { isMac } from './chords'
import { isolatedLaunch } from './dataHome'

test('on Linux the default Electron menu is replaced, so Ctrl+R and Ctrl+Q do nothing', async () => {
  test.skip(isMac, 'macOS has its own application menu')
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    const roles = await app.evaluate(({ Menu }) =>
      (Menu.getApplicationMenu()?.items ?? []).flatMap((item) =>
        (item.submenu?.items ?? []).map((sub) => sub.role),
      ),
    )
    expect(roles).toEqual(['togglefullscreen', 'toggledevtools'])

    await win.evaluate(() => {
      ;(window as unknown as { alive: boolean }).alive = true
    })
    const press = (key: string, modifiers: string[]) =>
      app.evaluate(
        ({ BrowserWindow }, input) => {
          const contents = BrowserWindow.getAllWindows()[0].webContents
          contents.focus()
          for (const type of ['rawKeyDown', 'char', 'keyUp'] as const) {
            contents.sendInputEvent({
              type,
              keyCode: input.key,
              modifiers: input.modifiers as Electron.InputEvent['modifiers'],
            })
          }
        },
        { key, modifiers },
      )
    await press('R', ['control'])
    await press('R', ['control', 'shift'])
    await press('Q', ['control'])
    await win.waitForTimeout(1500)
    expect(await win.evaluate(() => (window as unknown as { alive?: boolean }).alive)).toBe(true)

    await press('I', ['control', 'shift'])
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].webContents.isDevToolsOpened(),
        ),
      )
      .toBe(true)
  } finally {
    await app.close()
  }
})
