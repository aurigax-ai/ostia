import { _electron as electron, expect, test } from './test'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { openWorkspace } from './helpers'

test('actions from settings.json show in the pane header and tab menu, and elevated ones ask first', async () => {
  const dataHome = freshDataHome()
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    actions: [
      {
        id: 'split-down',
        title: 'Split below',
        command: 'pane.split',
        args: { direction: 'vertical' },
        icon: 'terminal',
        in: ['paneHeader'],
        paneKinds: ['terminal'],
      },
      { id: 'resume', title: 'Resume here', command: 'agent.resume', in: ['tabMenu'] },
    ],
  })
  const app = await electron.launch(isolatedLaunch(dataHome))
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await expect(win.locator('.xterm')).toHaveCount(1, { timeout: 15_000 })

    await win.locator('.pane.active').getByRole('button', { name: 'Split below' }).click()
    await expect(win.locator('.xterm')).toHaveCount(2, { timeout: 15_000 })

    await win.locator('.pane-tab').first().click({ button: 'right' })
    await win.getByRole('menuitem', { name: 'Resume here' }).click()
    const dialog = win.getByRole('dialog', { name: 'Run “Resume here”?' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('agent.resume')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toHaveCount(0)
  } finally {
    await app.close()
  }
})
