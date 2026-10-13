import { chords } from './chords'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { PROMPT, addTab, openWorkspace, restartApp } from './helpers'
import { type Page, _electron as electron, expect, test } from './test'

function frames(win: Page): Promise<void> {
  return win.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
}

test('a tab is renamed by double-click, the name survives a restart, and Escape in the menu rename keeps it', async () => {
  const dataHome = freshDataHome()
  let app = await electron.launch(isolatedLaunch(dataHome))
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    const main = win.locator('.pane-tab .pane-tab-main').first()

    await main.dblclick()
    const input = win.getByRole('textbox', { name: 'Rename Tab…' })
    await expect(input).toBeVisible()
    await frames(win)
    await expect(input).toBeFocused()
    await input.fill('builder')
    await input.press('Enter')
    await expect(input).toHaveCount(0)
    await expect(win.locator('.pane-tab .title').first()).toHaveText('builder')

    await restartApp(app, win)
  } finally {
    await app.close().catch(() => {})
  }

  app = await electron.launch(isolatedLaunch(dataHome))
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    const title = win.locator('.pane-tab .title').first()
    await expect(title).toHaveText('builder', { timeout: 15_000 })

    await win.locator('.pane-tab').first().click({ button: 'right' })
    await win.getByRole('menuitem', { name: 'Rename Tab…' }).click()
    const input = win.getByRole('textbox', { name: 'Rename Tab…' })
    await input.fill('discarded')
    await input.press('Escape')
    await expect(input).toHaveCount(0)
    await expect(title).toHaveText('builder')
  } finally {
    await app.close()
  }
})

test('arrow keys inside a split segment rename move the caret and keep the edit open', async () => {
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await addTab(win)
    const strip = win.getByRole('tablist')
    await expect(strip.getByRole('tab')).toHaveCount(2, { timeout: 15_000 })
    await expect(win.locator('.xterm-rows:visible')).toContainText(PROMPT, { timeout: 15_000 })
    await win.locator('.xterm:visible').click()
    await win.keyboard.press(chords.splitRight)
    const segments = strip.locator('.pane-split-tab .split-tab-segment')
    await expect(segments).toHaveCount(2, { timeout: 15_000 })

    await segments.nth(1).locator('.split-tab-segment-main').dblclick()
    const input = win.getByRole('textbox', { name: 'Rename Tab…' })
    await expect(input).toBeVisible()
    await frames(win)
    await expect(input).toBeFocused()
    await win.keyboard.type('abc')
    await win.keyboard.press('ArrowLeft')
    await win.keyboard.press('ArrowLeft')
    await expect(input).toBeFocused()
    await win.keyboard.type('X')
    await win.keyboard.press('Enter')
    await expect(input).toHaveCount(0)
    await expect(segments.nth(1)).toContainText('aXbc')
  } finally {
    await app.close()
  }
})
