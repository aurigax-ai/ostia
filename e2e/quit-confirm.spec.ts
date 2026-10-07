import { type Page, _electron as electron, expect, test } from './test'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { openWorkspace, pressQuit } from './helpers'

const PLAIN_SHELL = {
  ...DOM_RENDERER_SETTINGS,
  workspaces: { ...DOM_RENDERER_SETTINGS.workspaces, confirmQuit: true },
  terminal: { shell: '/bin/sh -i' },
}

async function launch(settings: object) {
  const dataHome = freshDataHome()
  seedSettings(dataHome, settings)
  const app = await electron.launch(isolatedLaunch(dataHome))
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await openWorkspace(win)
  return { app, win }
}

async function run(win: Page, command: string): Promise<void> {
  await win.locator('.xterm').first().click()
  await win.keyboard.type(command)
  await win.keyboard.press('Enter')
}

test('quitting with only idle shells shows no dialog', async () => {
  const { app, win } = await launch({
    ...DOM_RENDERER_SETTINGS,
    workspaces: { ...DOM_RENDERER_SETTINGS.workspaces, confirmQuit: true },
  })
  try {
    expect(await pressQuit(app, win)).toBe('quit')
  } finally {
    app.process().kill('SIGKILL')
  }
})

test('quitting with a program running in a shell without blocks asks and names it', async () => {
  const { app, win } = await launch(PLAIN_SHELL)
  try {
    await run(win, 'echo plain-$((6*7)); sleep 100')
    await expect(win.locator('.xterm-rows').first()).toContainText('plain-42', { timeout: 15_000 })
    expect(await pressQuit(app, win)).toBe('asked')
    const dialog = win.getByRole('dialog')
    await expect(dialog).toContainText('1 shell process will be ended')
    await expect(dialog).toContainText('sleep')
  } finally {
    app.process().kill('SIGKILL')
  }
})

test('quitting with an idle shell without blocks shows no dialog', async () => {
  const { app, win } = await launch(PLAIN_SHELL)
  try {
    await run(win, 'echo idle-$((6*7))')
    await expect(win.locator('.xterm-rows').first()).toContainText('idle-42', { timeout: 15_000 })
    expect(await pressQuit(app, win)).toBe('quit')
  } finally {
    app.process().kill('SIGKILL')
  }
})

test('quitting while the window is too busy to answer asks instead of quitting', async () => {
  const { app, win } = await launch({
    ...DOM_RENDERER_SETTINGS,
    workspaces: { ...DOM_RENDERER_SETTINGS.workspaces, confirmQuit: true },
  })
  try {
    await app.evaluate(({ dialog }) => {
      const asked: string[] = []
      Object.assign(globalThis, { quitAsked: asked })
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const options = args.at(-1) as { detail?: string }
        asked.push(options.detail ?? '')
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
      .poll(() => app.evaluate(() => (globalThis as { quitAsked?: string[] }).quitAsked ?? []), {
        timeout: 15_000,
      })
      .toEqual([expect.stringContaining('The window did not answer')])
    expect(app.process().exitCode).toBeNull()
  } finally {
    app.process().kill('SIGKILL')
  }
})
