import { type Page, _electron as electron, expect, test } from '@playwright/test'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { PROMPT, emptyWorkspace, openWorkspace } from './helpers'

const visibleTabs = (win: Page) => win.locator('.pane-tab:visible')

async function newTerminalWorkspace(win: Page): Promise<void> {
  const before = await win.locator('.xterm').count()
  await win.locator('.topbar').getByRole('button', { name: 'New workspace' }).click()
  await emptyWorkspace(win).getByRole('button', { name: 'New terminal' }).click()
  await expect(win.locator('.xterm')).toHaveCount(before + 1, { timeout: 15_000 })
  await expect(win.locator('.pane-slot:not([data-hidden]) .xterm-rows').last()).toContainText(
    PROMPT,
    { timeout: 15_000 },
  )
}

async function renameRow(win: Page, index: number, name: string): Promise<void> {
  await win.locator('.rail-tab-main').nth(index).dblclick()
  const input = win.locator('.rail-row input').first()
  await input.fill(name)
  await input.press('Enter')
  await expect(win.locator('.rail-row').nth(index)).toContainText(name)
}

async function runIn(win: Page, tabId: string, command: string): Promise<void> {
  await win.locator(`.pane-tab[data-tab-id="${tabId}"]`).click()
  await win.locator('.pane-slot:not([data-hidden]) .xterm:visible').first().click()
  await win.keyboard.type(command)
  await win.keyboard.press('Enter')
}

test('a running tab moves to another workspace by its menu and back by a rail drop, same process', async () => {
  test.setTimeout(150_000)
  const app = await electron.launch(isolatedLaunch(freshDataHome()))
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await win.getByRole('button', { name: 'New terminal tab' }).first().click()
    await expect(visibleTabs(win)).toHaveCount(2)
    const [home, moving] = await visibleTabs(win).evaluateAll((tabs) =>
      tabs.map((t) => t.getAttribute('data-tab-id') ?? ''),
    )
    await expect(win.locator('.xterm-rows:visible')).toContainText(PROMPT, { timeout: 15_000 })

    await runIn(win, moving, "sh -c 'echo pid-$$-up; exec sleep 777'")
    const screen = win.locator('.pane-slot:not([data-hidden]) .xterm-rows:visible')
    await expect(screen).toContainText(/pid-\d+-up/, { timeout: 15_000 })
    const pid = (await screen.textContent())?.match(/pid-(\d+)-up/)?.[1]
    if (!pid) throw new Error('no pid')
    await win
      .locator('.pane-slot:not([data-hidden]) .xterm:visible')
      .evaluate((el) => el.setAttribute('data-move-mark', 'moving'))

    await newTerminalWorkspace(win)
    await renameRow(win, 0, 'source')
    await renameRow(win, 1, 'target')
    await win.locator('.rail-tab-main').nth(0).click()
    await expect(visibleTabs(win)).toHaveCount(2)

    await win.locator(`.pane-tab[data-tab-id="${moving}"]`).click({ button: 'right' })
    await win.getByRole('menuitem', { name: 'Move to workspace' }).click()
    await win.getByRole('menuitem', { name: 'target' }).click()

    await expect(visibleTabs(win)).toHaveCount(1)
    await expect(win.locator('.rail-row')).toHaveCount(2)
    await win.locator('.rail-tab-main').nth(1).click()
    await expect(visibleTabs(win)).toHaveCount(2)
    await expect(win.locator(`.pane-tab[data-tab-id="${moving}"]:visible`)).toHaveCount(1)
    await expect(win.locator('.xterm[data-move-mark="moving"]')).toHaveCount(1)
    await expect(win.locator('.xterm[data-move-mark="moving"]')).toBeVisible()
    await expect(win.locator('.xterm[data-move-mark="moving"] .xterm-rows')).toContainText(
      `pid-${pid}-up`,
    )

    const targetHome = await visibleTabs(win).evaluateAll(
      (tabs, id) => tabs.map((t) => t.getAttribute('data-tab-id') ?? '').find((t) => t !== id),
      moving,
    )
    if (!targetHome) throw new Error('no target tab')
    await runIn(win, targetHome, `kill -0 ${pid} && echo alive-$((${pid}+0))`)
    await expect(win.locator('.pane-slot:not([data-hidden]) .xterm-rows:visible')).toContainText(
      `alive-${pid}`,
      { timeout: 10_000 },
    )

    await win
      .locator(`.pane-tab[data-tab-id="${moving}"]`)
      .dragTo(win.locator('.rail-row').nth(0))
    await expect(visibleTabs(win)).toHaveCount(1)
    await expect(win.locator('.pane-drop-layer')).toHaveCount(0)
    await win.locator('.rail-tab-main').nth(0).click()
    await expect(visibleTabs(win)).toHaveCount(2)
    await expect(win.locator(`.pane-tab[data-tab-id="${home}"]:visible`)).toHaveCount(1)
    await expect(win.locator('.xterm[data-move-mark="moving"]')).toBeVisible()

    await runIn(win, home, `kill -0 ${pid} && echo again-$((${pid}+0))`)
    await expect(win.locator('.pane-slot:not([data-hidden]) .xterm-rows:visible')).toContainText(
      `again-${pid}`,
      { timeout: 10_000 },
    )
  } finally {
    await app
      .evaluate(({ app: electronApp }) => {
        setTimeout(() => electronApp.quit(), 0)
      })
      .catch(() => {})
    await app.close().catch(() => {})
  }
})
