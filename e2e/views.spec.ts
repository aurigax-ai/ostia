import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Locator, type Page, _electron as electron, expect, test } from './test'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace, waitForPaletteSelection } from './helpers'

const AGENTS_VIEW = {
  version: 1,
  title: 'Agents',
  placement: 'sidebar',
  icon: 'robot',
  root: {
    type: 'stack',
    children: [
      { type: 'text', text: '{{workspaces | count}} open', tone: 'muted', size: 'xs' },
      {
        type: 'list',
        for: 'workspaces',
        as: 'ws',
        item: { type: 'text', text: 'ws: {{ws.name}}' },
      },
      {
        type: 'button',
        label: 'Start from view',
        icon: 'plus',
        action: { command: 'workspace.new', args: { name: 'from-view' } },
      },
    ],
  },
}

const BOARD_VIEW = {
  version: 1,
  title: 'Board',
  placement: 'panel',
  root: {
    type: 'kv',
    items: [{ key: 'Current', value: '{{workspace.name}}' }],
  },
}

test('a view file shows in the sidebar only after the human enables it, with live data and working buttons', async () => {
  const dataHome = freshDataHome()
  const viewsDir = join(dataHome, 'config', 'ostia', 'views')
  mkdirSync(viewsDir, { recursive: true })
  writeFileSync(join(viewsDir, 'agents.json'), JSON.stringify(AGENTS_VIEW, null, 2))
  const app = await electron.launch(isolatedLaunch(dataHome))
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    const firstName = (await win.locator('.rail-row .tab-title').first().innerText()).trim()
    const rail = win.getByRole('region', { name: 'Agents' })
    await expect(rail).toHaveCount(0)

    await win.locator('.topbar').getByRole('button', { name: 'Settings' }).click()
    const settings = win.getByRole('region', { name: 'Settings' })
    await settings.getByRole('button', { name: 'Views', exact: true }).click()
    const row = settings.locator('[data-view-row="agents"]')
    await expect(row).toContainText('New')
    await row.getByRole('switch', { name: 'Show Agents' }).click()
    await expect(row).not.toContainText('New')

    writeFileSync(join(viewsDir, 'board.json'), JSON.stringify(BOARD_VIEW, null, 2))
    const board = settings.locator('[data-view-row="board"]')
    await expect(board).toContainText('New', { timeout: 10_000 })
    await board.getByRole('switch', { name: 'Show Board' }).click()
    await win.keyboard.press('Escape')
    await expect(settings).toHaveCount(0)

    await expect(rail).toBeVisible()
    await expect(rail).toContainText('1 open')
    await expect(rail).toContainText(`ws: ${firstName}`)

    await rail.getByRole('button', { name: 'Start from view' }).click()
    await expect(rail).toContainText('2 open', { timeout: 10_000 })
    await expect(rail).toContainText('ws: from-view')
    await expect(win.locator('.rail-row', { hasText: 'from-view' })).toHaveCount(1)

    await win.keyboard.press('Control+Shift+P')
    await win.locator('[data-slot="command-input"]').fill('Views: Open Board')
    await waitForPaletteSelection(win, 'Views: Open Board')
    await win.keyboard.press('Enter')
    const pane = win.locator('[data-view="board"]')
    await expect(pane).toBeVisible({ timeout: 10_000 })
    await expect(pane).toContainText('Current')
    await expect(pane).toContainText('from-view')
  } finally {
    await app.close()
  }
})

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
