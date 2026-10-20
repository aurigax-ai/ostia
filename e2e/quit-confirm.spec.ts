import { DOM_RENDERER_SETTINGS, freshDataHome, seedSettings } from './dataHome'
import { launchWindow, openWorkspace, pressQuit, runInTerminal } from './helpers'
import { expect, test } from './test'

const CONFIRM_QUIT = {
  ...DOM_RENDERER_SETTINGS,
  workspaces: { ...DOM_RENDERER_SETTINGS.workspaces, confirmQuit: true },
}

const PLAIN_SHELL = {
  ...CONFIRM_QUIT,
  terminal: { shell: '/bin/sh -i' },
}

async function launch(settings: object) {
  const dataHome = freshDataHome()
  seedSettings(dataHome, settings)
  const { app, win } = await launchWindow(dataHome)
  await openWorkspace(win)
  return { app, win, proc: app.process() }
}

test(
  'quitting with a program running in a shell without blocks asks and names it',
  { tag: '@core' },
  async () => {
    const { app, win, proc } = await launch(PLAIN_SHELL)
    try {
      await runInTerminal(win, 'echo plain-$((6*7)); sleep 100')
      await expect(win.locator('.xterm-rows').first()).toContainText('plain-42', {
        timeout: 15_000,
      })
      const paneId = await win.locator('.pane').first().getAttribute('data-pane-id')
      await expect
        .poll(() => win.evaluate((id) => window.ostia.pty.foreground(id ?? ''), paneId))
        .toBe('sleep')
      expect(await pressQuit(app, win)).toBe('asked')
      const dialog = win.getByRole('dialog')
      await expect(dialog).toContainText('1 shell process will be ended')
      await expect(dialog).toContainText('sleep')
    } finally {
      proc.kill('SIGKILL')
    }
  },
)
