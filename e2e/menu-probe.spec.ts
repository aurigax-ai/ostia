import { _electron as electron, test } from '@playwright/test'
import { isolatedLaunch } from './dataHome'

const press = (app: Awaited<ReturnType<typeof electron.launch>>, key: string, mods: string[]) =>
  app.evaluate(
    async ({ BrowserWindow }, k) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.webContents.focus()
      for (const type of ['rawKeyDown', 'char', 'keyUp'] as const) {
        win.webContents.sendInputEvent({
          type,
          keyCode: k.key,
          modifiers: k.mods as Electron.InputEvent['modifiers'],
        })
      }
    },
    { key, mods },
  )

test('probe: do default menu accelerators fire on Linux', async () => {
  const out: string[] = []
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await win.evaluate(() => {
      ;(window as unknown as { __probe: number }).__probe = 1
    })
    await win.locator('body').click()
    await press(app, 'R', ['control'])
    await win.waitForTimeout(2000)
    out.push(
      `ctrlR survived=${await win.evaluate(() => (window as unknown as { __probe?: number }).__probe ?? null).catch(() => 'gone')}`,
    )
    await press(app, 'I', ['control', 'shift'])
    await win.waitForTimeout(1500)
    out.push(
      `ctrlShiftI devtoolsOpened=${await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.isDevToolsOpened())}`,
    )
    await press(app, '0', ['control'])
    await press(app, '=', ['control', 'shift'])
    await win.waitForTimeout(500)
    out.push(
      `zoomFactor=${await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor())}`,
    )
    const closed = new Promise<string>((done) => {
      app.once('close', () => done('closed'))
      setTimeout(() => done('still-open'), 6000)
    })
    await press(app, 'Q', ['control'])
    out.push(`ctrlQ ${await closed}`)
  } catch (e) {
    out.push(`error ${String(e)}`)
  } finally {
    await app.close().catch(() => undefined)
  }
  throw new Error(`MENU_PROBE2 ${out.join(' | ')}`)
})
