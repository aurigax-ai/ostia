import {
  type ElectronApplication,
  type Page,
  _electron as electron,
  expect,
  test,
} from '@playwright/test'
import { isolatedLaunch } from './dataHome'

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

async function waitForShellPrompt(win: Page): Promise<void> {
  const term = win.locator('.xterm').first()
  await expect(term).toBeVisible({ timeout: 15_000 })
  await expect(win.locator('.xterm-rows').first()).toContainText(/[❯$%#]/, { timeout: 15_000 })
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
    await waitForShellPrompt(win)

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
    await expect(win.locator('.xterm')).toHaveCount(1, { timeout: 15_000 })
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
    await expect(win.locator('.xterm').first()).toBeVisible({ timeout: 15_000 })
    await expect(win.locator('.rail-tab')).toHaveCount(1)

    await win.keyboard.press('Control+Shift+P')
    const dialog = win.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 5_000 })

    await win.locator('[data-slot="command-input"]').fill('New Session')
    await expect(dialog.getByText('New Session', { exact: true })).toBeVisible()
    await expect(dialog.getByText('Split Pane Right', { exact: true })).toHaveCount(0)

    await win.keyboard.press('Enter')
    await expect(dialog).toBeHidden({ timeout: 5_000 })
    await expect(win.locator('.rail-tab')).toHaveCount(2, { timeout: 5_000 })
  } finally {
    await app.close()
  }
})

test('opening a file shows the Monaco editor', async () => {
  const { app, win } = await launchApp()
  try {
    await expect(win.locator('.xterm').first()).toBeVisible({ timeout: 15_000 })
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
