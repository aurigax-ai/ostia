import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type ElectronApplication,
  type Page,
  _electron as electron,
  expect,
  test,
} from '@playwright/test'
import { freshDataHome, isolatedLaunch } from './dataHome'

interface Launched {
  app: ElectronApplication
  win: Page
}

async function launchApp(dataHome: string): Promise<Launched> {
  const app = await electron.launch(isolatedLaunch(dataHome))
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
  await expect(win.locator('.xterm').first()).toBeVisible({ timeout: 15_000 })
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

async function quitApp(app: ElectronApplication): Promise<void> {
  await app
    .evaluate(({ app: electronApp }) => {
      setTimeout(() => electronApp.quit(), 0)
    })
    .catch(() => {})
  await app.close().catch(() => {})
}

let dataHome: string

test.beforeEach(() => {
  dataHome = freshDataHome()
})

test('restores the pane layout and terminal history after a restart', async () => {
  const marker = `pine_restore_${Date.now()}`

  const first = await launchApp(dataHome)
  try {
    await waitForShellPrompt(first.win)
    await expect(first.win.locator('.pane.active')).toBeVisible({ timeout: 15_000 })

    const term = first.win.locator('.xterm').first()
    await term.click()
    await waitForTerminalFocus(first.win)
    await first.win.keyboard.type(`echo ${marker}`)
    await first.win.keyboard.press('Enter')
    await expect(first.win.locator('.xterm-rows').first()).toContainText(marker, {
      timeout: 15_000,
    })

    await first.win.locator('.pane.active').getByRole('button', { name: 'Split right' }).click()
    await expect(first.win.locator('.pane')).toHaveCount(2)
  } finally {
    await quitApp(first.app)
  }

  const snapshotFile = join(dataHome, 'pine', 'sessions.json')
  const scrollbackFile = join(dataHome, 'pine', 'scrollback.json')
  expect(existsSync(snapshotFile), 'workspace snapshot was not written at quit').toBe(true)
  expect(existsSync(scrollbackFile), 'scrollback was not written at quit').toBe(true)
  expect(readFileSync(scrollbackFile, 'utf8')).toContain(marker)

  const second = await launchApp(dataHome)
  try {
    await expect(second.win.locator('.pane')).toHaveCount(2, { timeout: 15_000 })
    await expect(second.win.locator('.workzone')).toContainText(marker, { timeout: 15_000 })
    await expect(second.win.locator('.workzone')).toContainText('session restored', {
      timeout: 15_000,
    })
  } finally {
    await quitApp(second.app)
  }
})

test('restores terminal history after a crash (no before-quit)', async () => {
  const marker = `pine_crash_${Date.now()}`
  const first = await launchApp(dataHome)
  try {
    await waitForShellPrompt(first.win)
    await first.win.locator('.xterm').first().click()
    await waitForTerminalFocus(first.win)
    await first.win.keyboard.type(`echo ${marker}`)
    await first.win.keyboard.press('Enter')
    await expect(first.win.locator('.xterm-rows').first()).toContainText(marker, {
      timeout: 15_000,
    })
    const scrollbackFile = join(dataHome, 'pine', 'scrollback.json')
    await expect
      .poll(
        () => existsSync(scrollbackFile) && readFileSync(scrollbackFile, 'utf8').includes(marker),
        {
          timeout: 15_000,
        },
      )
      .toBe(true)
  } finally {
    first.app.process().kill('SIGKILL')
  }

  const second = await launchApp(dataHome)
  try {
    await expect(second.win.locator('.workzone')).toContainText(marker, { timeout: 15_000 })
  } finally {
    await quitApp(second.app)
  }
})

test('boots a single fresh session when there is nothing to restore', async () => {
  const { app, win } = await launchApp(dataHome)
  try {
    await waitForShellPrompt(win)
    await expect(win.locator('.pane')).toHaveCount(1)
    await expect(win.locator('.workzone')).not.toContainText('session restored')
  } finally {
    await quitApp(app)
  }
})

test('erases stored history when session restore is switched off', async () => {
  const first = await launchApp(dataHome)
  try {
    await waitForShellPrompt(first.win)
  } finally {
    await quitApp(first.app)
  }
  expect(existsSync(join(dataHome, 'pine', 'sessions.json'))).toBe(true)

  const second = await launchApp(dataHome)
  try {
    await waitForShellPrompt(second.win)
    await second.win.keyboard.press('Control+,')
    const settings = second.win.getByRole('region', { name: 'Settings' })
    await expect(settings).toBeVisible({ timeout: 10_000 })
    await settings.getByRole('button', { name: 'Terminal', exact: true }).click()

    const toggle = settings.getByLabel('Restore session on launch')
    await expect(toggle).toBeVisible({ timeout: 10_000 })
    await toggle.click()

    await expect
      .poll(() => existsSync(join(dataHome, 'pine', 'sessions.json')), { timeout: 10_000 })
      .toBe(false)
  } finally {
    await quitApp(second.app)
  }
})
