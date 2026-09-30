import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
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
  const viewsDir = join(dataHome, 'config', 'pine', 'views')
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
