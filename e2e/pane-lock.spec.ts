import { type Page, _electron as electron, expect, test } from '@playwright/test'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { PROMPT, openWorkspace } from './helpers'

async function run(win: Page, line: string): Promise<void> {
  await win.locator('.xterm').first().click()
  await win.keyboard.type(line)
  await win.keyboard.press('Enter')
}

async function closeFromAgent(win: Page, paneId: string, marker: string): Promise<void> {
  await run(win, `ostia pane.close '{"paneId":"${paneId}"}'; echo ${marker}-$?`)
  const card = win.getByRole('region', { name: 'Agent permission request' })
  await expect(card).toBeVisible({ timeout: 20_000 })
  await card.getByRole('button', { name: 'Allow once' }).click()
  await expect(win.locator('.xterm-rows').first()).toContainText(new RegExp(`${marker}-\\d`), {
    timeout: 15_000,
  })
}

test('an agent closes a busy tab without a confirm, but never a tab the human locked', async () => {
  const app = await electron.launch(isolatedLaunch(freshDataHome()))
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    const tabs = win.locator('.pane-tab')

    await win.getByRole('button', { name: 'New terminal tab' }).click()
    await expect(tabs).toHaveCount(2)
    await expect(win.locator('.xterm-rows').nth(1)).toContainText(PROMPT, { timeout: 15_000 })
    await win.locator('.xterm').nth(1).click()
    await win.keyboard.type('echo "BUSY=$OSTIA_PANE_ID."; sleep 300')
    await win.keyboard.press('Enter')
    const busyRows = win.locator('.xterm-rows').nth(1)
    await expect(busyRows).toContainText(/BUSY=[\w-]+\./, { timeout: 15_000 })
    const busy = (await busyRows.textContent())?.match(/BUSY=([\w-]+)\./)?.[1]
    await tabs.nth(0).getByRole('tab').click()

    await tabs.nth(1).click({ button: 'right' })
    await win.getByRole('menuitem', { name: 'Lock tab' }).click()
    await expect(tabs.nth(1)).toHaveClass(/locked/)
    await expect(tabs.nth(1).getByRole('button', { name: 'Close tab' })).toHaveCount(0)

    await closeFromAgent(win, busy ?? '', 'LOCKED')
    await expect(win.locator('.xterm-rows').first()).toContainText('pane-locked')
    await expect(tabs).toHaveCount(2)

    await tabs.nth(1).getByRole('button', { name: 'Unlock tab' }).click()
    await expect(tabs.nth(1)).not.toHaveClass(/locked/)

    await closeFromAgent(win, busy ?? '', 'OPEN')
    await expect(tabs).toHaveCount(1)
    await expect(win.getByRole('alertdialog')).toHaveCount(0)
    await expect(win.locator('.xterm-rows').first()).toContainText('OPEN-0')
  } finally {
    await app.close()
  }
})

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

    await run(win, 'sleep 30')
    await expect.poll(local, { timeout: 10_000 }).toBe(false)
    expect(await names()).toBe(0)
    expect(await win.evaluate((id) => window.ostia.pty.listDir(id, '/'), paneId)).toEqual([])
  } finally {
    await app.close()
  }
})
