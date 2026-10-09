import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace, waitForPaletteSelection } from './helpers'
import { type Locator, type Page, _electron as electron, expect, test } from './test'

const BOARD_VIEW = {
  version: 1,
  title: 'Board',
  placement: 'panel',
  root: {
    type: 'kv',
    items: [{ key: 'Current', value: '{{workspace.name}}' }],
  },
}

async function openBoard(win: Page): Promise<Locator> {
  await win.keyboard.press('Control+Shift+P')
  await win.locator('[data-slot="command-input"]').fill('Views: Open Board')
  await waitForPaletteSelection(win, 'Views: Open Board')
  await win.keyboard.press('Enter')
  await expect(win.locator('[data-slot="command"]')).toHaveCount(0)
  const pane = win.locator('.pane', { has: win.locator('[data-view="board"]') })
  await expect(pane).toBeVisible({ timeout: 10_000 })
  return pane
}

async function widthOf(pane: Locator): Promise<number> {
  return (await pane.boundingBox())?.width ?? 0
}

async function closeBoard(win: Page, pane: Locator): Promise<void> {
  await pane.locator('.pane-tab').first().hover()
  await pane.getByRole('button', { name: 'Close tab' }).click()
  await expect(win.locator('[data-view="board"]')).toHaveCount(0)
}

async function expectWidthNear(pane: Locator, width: number): Promise<void> {
  await expect.poll(async () => Math.abs((await widthOf(pane)) - width)).toBeLessThan(4)
}

test('a panel reopens at the width the human dragged it to, also after a restart', async () => {
  test.setTimeout(90_000)
  const dataHome = freshDataHome()
  const viewsDir = join(dataHome, 'config', 'ostia', 'views')
  mkdirSync(viewsDir, { recursive: true })
  writeFileSync(join(viewsDir, 'board.json'), JSON.stringify(BOARD_VIEW, null, 2))
  let app = await electron.launch(isolatedLaunch(dataHome))
  let draggedWidth = 0
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)

    await win.locator('.topbar').getByRole('button', { name: 'Settings' }).click()
    const settings = win.getByRole('region', { name: 'Settings' })
    await settings.getByRole('button', { name: 'Views', exact: true }).click()
    await settings
      .locator('[data-view-row="board"]')
      .getByRole('switch', { name: 'Show Board' })
      .click()
    await win.keyboard.press('Escape')
    await expect(settings).toHaveCount(0)

    let pane = await openBoard(win)
    const split = win.locator('.split-view', { has: pane }).first()
    const total = (await split.boundingBox())?.width ?? 0
    await expectWidthNear(pane, total / 2)

    const sash = split.locator('[class*="sash-module_sash"]').first()
    await sash.hover()
    const box = await sash.boundingBox()
    if (!box) throw new Error('no splitter')
    const startX = box.x + box.width / 2
    const y = box.y + box.height / 2
    await win.mouse.down()
    await win.mouse.move(startX + 20, y, { steps: 4 })
    await win.mouse.move(startX + total * 0.2, y, { steps: 10 })
    await win.mouse.up()
    draggedWidth = await widthOf(pane)
    expect(draggedWidth).toBeLessThan(total * 0.4)

    await closeBoard(win, pane)
    pane = await openBoard(win)
    await expectWidthNear(pane, draggedWidth)

    await closeBoard(win, pane)
    await expect
      .poll(() => win.evaluate(() => window.localStorage.getItem('panelSizes') ?? ''))
      .toContain('view:board')
  } finally {
    await app.close()
  }

  app = await electron.launch(isolatedLaunch(dataHome))
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await expect(win.locator('.xterm')).toHaveCount(1, { timeout: 15_000 })
    const pane = await openBoard(win)
    await expectWidthNear(pane, draggedWidth)
  } finally {
    await app.close()
  }
})
