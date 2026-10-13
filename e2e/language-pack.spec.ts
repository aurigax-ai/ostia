import { zhHant } from '../src/shared/app/dict'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { emptyState, emptyWorkspace } from './helpers'
import { _electron as electron, expect, test } from './test'

test('the main process asks in the language of the chosen pack: the native quit prompt', async () => {
  const dataHome = freshDataHome()
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    locale: 'zh-Hant',
    workspaces: { ...DOM_RENDERER_SETTINGS.workspaces, confirmQuit: true },
  })
  const quit = zhHant.native.quit
  const app = await electron.launch(isolatedLaunch(dataHome))
  const proc = app.process()
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await emptyState(win)
      .getByRole('button', { name: new RegExp(zhHant.rail.newWorkspace) })
      .click()
    await emptyWorkspace(win)
      .getByRole('button', { name: new RegExp(zhHant.pane.newTerminal) })
      .click()
    await expect(win.locator('.xterm').first()).toBeVisible({ timeout: 15_000 })
    await app.evaluate(({ dialog }) => {
      const asked: unknown[] = []
      Object.assign(globalThis, { quitAsked: asked })
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const options = args.at(-1) as { title?: string; detail?: string; buttons?: string[] }
        asked.push({ title: options.title, detail: options.detail, buttons: options.buttons })
        return { response: 0, checkboxChecked: false }
      }) as typeof dialog.showMessageBox
    })
    void win
      .evaluate(() => {
        window.ostia.window.quit()
        const end = Date.now() + 5_000
        while (Date.now() < end) {}
      })
      .catch(() => {})
    await expect
      .poll(() => app.evaluate(() => (globalThis as { quitAsked?: unknown[] }).quitAsked ?? []), {
        timeout: 15_000,
      })
      .toEqual([
        {
          title: quit.title,
          detail: expect.stringContaining(quit.unanswered),
          buttons: [quit.cancel, quit.quit],
        },
      ])
    expect(proc.exitCode).toBeNull()
  } finally {
    proc.kill('SIGKILL')
  }
})
