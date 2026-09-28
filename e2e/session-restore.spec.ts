import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type ElectronApplication,
  type Page,
  _electron as electron,
  expect,
  test,
} from '@playwright/test'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { emptyState, openSession } from './helpers'

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
    await openSession(first.win)
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
    await openSession(first.win)
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

async function setWindowSize(app: ElectronApplication, width: number, height: number) {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height)
    },
    { width, height },
  )
}

async function wobbleWidth(app: ElectronApplication): Promise<void> {
  for (const width of [1400, 1200, 1500, 1580]) {
    await setWindowSize(app, width, 950)
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
}

async function paneLines(win: Page): Promise<string[]> {
  const text = await win.locator('.xterm-rows').first().innerText()
  return text.split('\n').map((l) => l.replace(/ /g, ' ').trimEnd())
}

test('restores a clean final screen at a different window size', async () => {
  test.setTimeout(90_000)
  const marker = `pine_resized_${Date.now()}`
  const userData = join(dataHome, 'userData')
  mkdirSync(userData, { recursive: true })
  writeFileSync(
    join(userData, 'settings.json'),
    JSON.stringify({ appearance: { terminal: { size: 8 } } }),
  )

  const first = await launchApp(dataHome)
  try {
    await setWindowSize(first.app, 1580, 950)
    await openSession(first.win)
    await first.win.waitForTimeout(1_000)
    await wobbleWidth(first.app)
    await first.win.locator('.xterm').first().click()
    await waitForTerminalFocus(first.win)
    await first.win.keyboard.type(`printf '${marker}_%s\\n' 1 2`)
    await first.win.keyboard.press('Enter')
    await expect(first.win.locator('.xterm-rows').first()).toContainText(`${marker}_2`, {
      timeout: 15_000,
    })
    await wobbleWidth(first.app)
    await first.win.waitForTimeout(1_500)
  } finally {
    await quitApp(first.app)
  }

  const second = await launchApp(dataHome)
  try {
    await setWindowSize(second.app, 1000, 980)
    await expect(second.win.locator('.xterm-rows').first()).toContainText('session restored', {
      timeout: 15_000,
    })
    await waitForShellPrompt(second.win)
    await second.win.waitForTimeout(2_000)

    const lines = await paneLines(second.win)
    const seams = lines.flatMap((l, i) => (l.includes('session restored') ? [i] : []))
    expect(seams).toHaveLength(1)
    const [seam] = seams
    expect(lines.some((l) => l.trim() === '%')).toBe(false)
    expect(lines.slice(0, seam).join('\n')).toContain(`${marker}_1`)
    const history = lines.slice(0, seam).filter((l) => l.trim() !== '')
    expect(history[history.length - 1]).toBe(`${marker}_2`)
    expect(history.filter((l) => l.includes(`printf '${marker}`))).toHaveLength(1)
    expect(lines.slice(seam + 1).filter((l) => l.includes('❯'))).toHaveLength(1)
  } finally {
    await quitApp(second.app)
  }
})

test('boots with no sessions when there is nothing to restore', async () => {
  const { app, win } = await launchApp(dataHome)
  try {
    await expect(emptyState(win)).toBeVisible({ timeout: 15_000 })
    await win.waitForTimeout(1_000)
    await expect(win.locator('.xterm')).toHaveCount(0)
    await expect(win.locator('.pane')).toHaveCount(0)
    await expect(win.locator('.rail-tab')).toHaveCount(0)
  } finally {
    await quitApp(app)
  }
})

test('restores zero sessions after the last session was closed', async () => {
  const first = await launchApp(dataHome)
  try {
    await openSession(first.win)
    const tab = first.win.locator('.rail-tab')
    await tab.hover()
    await tab.getByRole('button', { name: 'Close' }).click()
    await expect(emptyState(first.win)).toBeVisible({ timeout: 5_000 })
    await expect
      .poll(
        () => {
          const file = join(dataHome, 'pine', 'sessions.json')
          return existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).sessions.length
        },
        { timeout: 10_000 },
      )
      .toBe(0)
  } finally {
    await quitApp(first.app)
  }

  const second = await launchApp(dataHome)
  try {
    await expect(emptyState(second.win)).toBeVisible({ timeout: 15_000 })
    await second.win.waitForTimeout(1_000)
    await expect(second.win.locator('.xterm')).toHaveCount(0)
    await expect(second.win.locator('.rail-tab')).toHaveCount(0)
  } finally {
    await quitApp(second.app)
  }
})

test('erases stored history when session restore is switched off', async () => {
  const first = await launchApp(dataHome)
  try {
    await openSession(first.win)
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
