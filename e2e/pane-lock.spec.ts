import { freshDataHome, isolatedLaunch } from './dataHome'
import { PROMPT, openWorkspace, runInTerminal } from './helpers'
import { _electron as electron, expect, test } from './test'

test('a tab closes when its shell exits by itself, unless the human locked it', async () => {
  const app = await electron.launch(isolatedLaunch(freshDataHome()))
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    const tabs = win.locator('.pane-tab')
    const newTab = win.getByRole('button', { name: 'New terminal tab' })

    await newTab.click()
    await expect(tabs).toHaveCount(2)
    await expect(win.locator('.xterm-rows').nth(1)).toContainText(PROMPT, { timeout: 15_000 })
    await win.locator('.xterm').nth(1).click()
    await win.keyboard.type('sleep 3.5; false; exit')
    await win.keyboard.press('Enter')
    await expect(tabs).toHaveCount(1, { timeout: 15_000 })

    await newTab.click()
    await expect(tabs).toHaveCount(2)
    await expect(win.locator('.xterm-rows').nth(1)).toContainText(PROMPT, { timeout: 15_000 })
    await tabs.nth(1).click({ button: 'right' })
    await win.getByRole('menuitem', { name: 'Lock tab' }).click()
    await win.locator('.xterm').nth(1).click()
    await win.keyboard.type('exit')
    await win.keyboard.press('Enter')
    await expect(win.locator('.xterm-rows').nth(1)).toContainText('[process exited]', {
      timeout: 15_000,
    })
    await expect(tabs).toHaveCount(2)
  } finally {
    await app.close()
  }
})

test('suggestions come from the pane’s own shell only while it holds the terminal', async () => {
  const app = await electron.launch(isolatedLaunch(freshDataHome()))
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    const paneId = (await win.locator('.pane-tab').first().getAttribute('data-tab-id')) ?? ''
    const local = (): Promise<boolean> =>
      win.evaluate((id) => window.ostia.pty.localPrompt(id), paneId)
    const names = (): Promise<number> =>
      win.evaluate(async (id) => (await window.ostia.pty.commands(id)).length, paneId)

    await expect.poll(local).toBe(true)
    await expect.poll(names).toBeGreaterThan(0)

    await runInTerminal(win, 'sleep 30')
    await expect.poll(local, { timeout: 10_000 }).toBe(false)
    expect(await names()).toBe(0)
    expect(await win.evaluate((id) => window.ostia.pty.listDir(id, '/'), paneId)).toEqual([])
  } finally {
    await app.close()
  }
})
