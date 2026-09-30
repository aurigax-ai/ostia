import {
  type ElectronApplication,
  type Page,
  _electron as electron,
  expect,
  test,
} from '@playwright/test'
import { homedir } from 'node:os'
import { isolatedLaunch } from './dataHome'
import { PROMPT, emptyState, emptyWorkspace, openWorkspace, waitForPaletteSelection } from './helpers'

interface Launched {
  app: ElectronApplication
  win: Page
}

async function launchApp(): Promise<Launched> {
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    return { app, win }
  } catch (err) {
    await app.close()
    throw err
  }
}

async function waitForTerminalFocus(win: Page): Promise<void> {
  await expect
    .poll(() =>
      win.evaluate(
        () => document.activeElement?.classList.contains('xterm-helper-textarea') ?? false,
      ),
    )
    .toBe(true)
}

test('terminal spawns and runs a command', async () => {
  const { app, win } = await launchApp()
  try {
    await openWorkspace(win)

    const term = win.locator('.xterm').first()
    await term.click()
    await waitForTerminalFocus(win)

    await win.keyboard.type('echo pine_e2e_$((21+21))')
    await win.keyboard.press('Enter')

    await expect(win.locator('.xterm-rows').first()).toContainText('pine_e2e_42', {
      timeout: 15_000,
    })
  } finally {
    await app.close()
  }
})

test('splitting a pane adds a second terminal', async () => {
  const { app, win } = await launchApp()
  try {
    await openWorkspace(win)
    await expect(win.locator('.xterm')).toHaveCount(1)
    await expect(win.locator('.pane.active')).toBeVisible({ timeout: 15_000 })

    const splitRight = win.locator('.pane.active').getByRole('button', { name: 'Split right' })
    await splitRight.click()

    await expect(win.locator('.xterm')).toHaveCount(2, { timeout: 15_000 })
    await expect(win.locator('.pane')).toHaveCount(2)
  } finally {
    await app.close()
  }
})

test('command palette opens, filters, and runs a command', async () => {
  const { app, win } = await launchApp()
  try {
    await expect(emptyState(win)).toBeVisible({ timeout: 15_000 })
    await expect(win.locator('.rail-tab')).toHaveCount(0)

    await win.keyboard.press('Control+Shift+P')
    const dialog = win.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 5_000 })

    await win.locator('[data-slot="command-input"]').fill('New Workspace')
    await waitForPaletteSelection(win, 'New Workspace')
    await expect(dialog.getByText('New Workspace', { exact: true })).toBeVisible()
    await expect(dialog.getByText('Split Pane Right', { exact: true })).toHaveCount(0)

    await win.keyboard.press('Enter')
    await expect(dialog).toBeHidden({ timeout: 5_000 })
    await expect(win.locator('.rail-tab')).toHaveCount(1, { timeout: 5_000 })
    await expect(emptyWorkspace(win).getByRole('button', { name: 'New terminal' })).toBeVisible()
    await expect(win.locator('.xterm')).toHaveCount(0)
    await expect(emptyState(win)).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('opening a file shows the Monaco editor', async () => {
  const { app, win } = await launchApp()
  try {
    await openWorkspace(win)
    await expect(win.locator('.monaco-editor')).toHaveCount(0)

    await win.locator('.deck-rail').getByRole('button', { name: 'Files', exact: true }).click()

    const fileRow = win.locator('.file-row:has(.file-twisty-spacer)').first()
    await expect(fileRow).toBeVisible({ timeout: 10_000 })
    const fileName = (await fileRow.locator('.file-name').innerText()).trim()
    expect(fileName.length).toBeGreaterThan(0)
    await fileRow.click()

    await expect(win.locator('.monaco-editor').first()).toBeVisible({ timeout: 15_000 })
    await expect(win.locator('.pane-header .title').filter({ hasText: fileName })).toBeVisible({
      timeout: 15_000,
    })
  } finally {
    await app.close()
  }
})

test('boots with no workspace, and Ctrl+Shift+T opens an empty one that offers a terminal', async () => {
  const { app, win } = await launchApp()
  const errors: string[] = []
  win.on('pageerror', (err) => errors.push(err.message))
  win.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })
  try {
    await expect(emptyState(win)).toBeVisible({ timeout: 15_000 })
    await expect(emptyState(win).getByRole('heading', { name: 'No workspaces' })).toBeVisible()
    await expect(emptyState(win).getByRole('button', { name: /New workspace/ })).toContainText(
      'Ctrl+Shift+T',
    )
    await win.waitForTimeout(1_000)
    await expect(win.locator('.xterm')).toHaveCount(0)

    await win.keyboard.press('Control+Shift+T')

    await expect(win.locator('.rail-tab')).toHaveCount(1)
    await expect(win.locator('.xterm')).toHaveCount(0)
    await emptyWorkspace(win).getByRole('button', { name: 'New terminal' }).click()
    await expect(win.locator('.xterm')).toHaveCount(1, { timeout: 15_000 })
    await expect(win.locator('.xterm-rows').first()).toContainText(PROMPT, { timeout: 15_000 })
    await expect(win.locator('.rail-tab')).toHaveCount(1)
    await expect(emptyState(win)).toHaveCount(0)
    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})

test('closing the only workspace shows the empty state, and New workspace opens a terminal at ~', async () => {
  test.setTimeout(60_000)
  const { app, win } = await launchApp()
  try {
    await openWorkspace(win)
    const tab = win.locator('.rail-tab')
    await expect(tab).toHaveCount(1)

    await tab.hover()
    await tab.getByRole('button', { name: 'Close' }).click()

    await expect(emptyState(win)).toBeVisible({ timeout: 5_000 })
    await expect(tab).toHaveCount(0)
    await win.waitForTimeout(1_000)
    await expect(win.locator('.xterm')).toHaveCount(0)
    await expect(tab).toHaveCount(0)

    await openWorkspace(win)
    await expect(tab).toHaveCount(1)
    await win.locator('.xterm').first().click()
    await waitForTerminalFocus(win)
    await win.keyboard.type('echo "pine_cwd:$PWD:"')
    await win.keyboard.press('Enter')
    await expect(win.locator('.xterm-rows').first()).toContainText(`pine_cwd:${homedir()}:`, {
      timeout: 15_000,
    })
  } finally {
    await app.close()
  }
})

test('Ctrl+1 jumps to the first workspace from a focused terminal, and rows drag to reorder', async () => {
  const { app, win } = await launchApp()
  try {
    await openWorkspace(win)
    await win.locator('.deck-rail').getByRole('button', { name: 'New workspace' }).click()
    await emptyWorkspace(win).getByRole('button', { name: 'New terminal' }).click()
    const rows = win.locator('.rail-row')
    await expect(rows).toHaveCount(2)
    await win.locator('.rail-tab-main').nth(1).dblclick()
    const name = win.getByRole('textbox', { name: 'Workspace name' })
    await name.fill('second')
    await name.press('Enter')

    await win.locator('.pane-slot:not([data-hidden]) .xterm').last().click()
    await waitForTerminalFocus(win)
    await win.keyboard.press('Control+1')
    await expect(win.locator('.rail-tab.active .tab-title')).toHaveText('home')

    await rows.nth(1).dragTo(rows.nth(0), { targetPosition: { x: 40, y: 4 } })
    await expect(win.locator('.rail-tab .tab-title').first()).toHaveText('second')
  } finally {
    await app.close()
  }
})
