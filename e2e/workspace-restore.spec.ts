import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CANVAS_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import {
  addTab,
  launchWindow,
  openWorkspace,
  PROMPT,
  quitApp,
  waitForTerminalFocus,
} from './helpers'
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  killApp,
  type Page,
  test,
} from './test'

interface Launched {
  app: ElectronApplication
  win: Page
}

async function waitForShellPrompt(win: Page): Promise<void> {
  await expect(win.locator('.ghostty-host').first()).toBeVisible({ timeout: 15_000 })
  await expect(win.locator('.terminal-text').first()).toContainText(PROMPT, { timeout: 15_000 })
}

let dataHome: string

test.beforeEach(() => {
  dataHome = freshDataHome()
})

test('restores the pane layout and terminal history after a restart', {
  tag: '@core',
}, async () => {
  const marker = `ostia_restore_${Date.now()}`

  const first = await launchWindow(dataHome)
  try {
    await openWorkspace(first.win)
    await expect(first.win.locator('.pane.active')).toBeVisible({ timeout: 15_000 })

    const term = first.win.locator('.ghostty-host').first()
    await term.click()
    await waitForTerminalFocus(first.win)
    await first.win.keyboard.type(`echo ${marker}`)
    await first.win.keyboard.press('Enter')
    await expect(first.win.locator('.terminal-text').first()).toContainText(marker, {
      timeout: 15_000,
    })

    await first.win.locator('.pane.active').getByRole('button', { name: 'Split right' }).click()
    await expect(first.win.locator('.pane')).toHaveCount(2)
  } finally {
    await quitApp(first.app)
  }

  const snapshotFile = join(dataHome, 'ostia', 'workspaces.json')
  const scrollbackFile = join(dataHome, 'ostia', 'scrollback.json')
  expect(existsSync(snapshotFile), 'workspace snapshot was not written at quit').toBe(true)
  expect(existsSync(scrollbackFile), 'scrollback was not written at quit').toBe(true)
  expect(readFileSync(scrollbackFile, 'utf8')).toContain(marker)

  const second = await launchWindow(dataHome)
  try {
    await expect(second.win.locator('.pane')).toHaveCount(2, { timeout: 15_000 })
    await expect(second.win.locator('.workzone')).toContainText(marker, { timeout: 15_000 })
    await expect(second.win.locator('.workzone')).toContainText('workspace restored', {
      timeout: 15_000,
    })
  } finally {
    await quitApp(second.app)
  }
})

test('the pane the human last used takes the keyboard after a restart, without a click', async () => {
  const shownRows = '.pane-slot:not([data-hidden]) .terminal-text'
  const first = await launchWindow(dataHome)
  try {
    await openWorkspace(first.win)
    await addTab(first.win)
    await expect(first.win.getByRole('tablist').getByRole('tab')).toHaveCount(2, {
      timeout: 15_000,
    })
    await expect(first.win.locator(shownRows)).toContainText(PROMPT, { timeout: 15_000 })
    await first.win.locator('.pane-slot:not([data-hidden]) .ghostty-host').click()
    await waitForTerminalFocus(first.win)
  } finally {
    await quitApp(first.app)
  }

  const second = await launchWindow(dataHome)
  try {
    await expect(second.win.getByRole('tablist').getByRole('tab')).toHaveCount(2, {
      timeout: 15_000,
    })
    await expect(second.win.locator(shownRows)).toHaveCount(1)
    await expect(second.win.locator(shownRows)).toContainText(PROMPT, { timeout: 15_000 })
    await second.win.keyboard.type('echo $((6*7))_typed')
    await second.win.keyboard.press('Enter')
    await expect(second.win.locator(shownRows)).toContainText('42_typed', { timeout: 15_000 })
    expect(
      await second.win.evaluate(() =>
        Boolean(document.activeElement?.closest('.pane-slot:not([data-hidden])')),
      ),
    ).toBe(true)
  } finally {
    await quitApp(second.app)
  }
})

test('restores terminal history after a crash (no before-quit)', { tag: '@core' }, async () => {
  const marker = `ostia_crash_${Date.now()}`
  const first = await launchWindow(dataHome)
  try {
    await openWorkspace(first.win)
    await first.win.locator('.ghostty-host').first().click()
    await waitForTerminalFocus(first.win)
    await first.win.keyboard.type(`echo ${marker}`)
    await first.win.keyboard.press('Enter')
    await expect(first.win.locator('.terminal-text').first()).toContainText(marker, {
      timeout: 15_000,
    })
    const scrollbackFile = join(dataHome, 'ostia', 'scrollback.json')
    await expect
      .poll(
        () => existsSync(scrollbackFile) && readFileSync(scrollbackFile, 'utf8').includes(marker),
        {
          timeout: 15_000,
        },
      )
      .toBe(true)
  } finally {
    await killApp(first.app)
  }

  const second = await launchWindow(dataHome)
  try {
    await expect(second.win.locator('.workzone')).toContainText(marker, { timeout: 15_000 })
  } finally {
    await quitApp(second.app)
  }
})

test('keeps the scrollback saved at quit when an autosave fires during teardown', async () => {
  const marker = `ostia_teardown_${Date.now()}`
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...launch,
    env: { ...launch.env, OSTIA_TEST_SCROLLBACK_AUTOSAVE_MS: '25' },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await win.locator('.ghostty-host').first().click()
    await waitForTerminalFocus(win)
    await win.keyboard.type(`echo ${marker}_$((6*7))`)
    await win.keyboard.press('Enter')
    await expect(win.locator('.terminal-text').first()).toContainText(`${marker}_42`, {
      timeout: 15_000,
    })
  } finally {
    await quitApp(app)
  }

  const scrollbackFile = join(dataHome, 'ostia', 'scrollback.json')
  expect(readFileSync(scrollbackFile, 'utf8')).toContain(`${marker}_42`)
})

async function setWindowSize({ app, win }: Launched, width: number, height: number): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height)
    },
    { width, height },
  )
  await expect.poll(() => win.evaluate(() => window.outerWidth)).toBe(width)
  await win.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  )
}

async function wobbleWidth(launched: Launched): Promise<void> {
  for (const width of [1400, 1200, 1500, 1580]) await setWindowSize(launched, width, 950)
}

function promptsAfterSeam(lines: string[]): number {
  const seam = lines.findIndex((l) => l.includes('workspace restored'))
  return lines.slice(seam + 1).filter((l) => l.includes('❯')).length
}

async function paneLines(win: Page): Promise<string[]> {
  const text = await win.locator('.terminal-text').first().innerText()
  return text.split('\n').map((l) => l.replace(/ /g, ' ').trimEnd())
}

test('restores a clean final screen at a different window size', async () => {
  test.setTimeout(90_000)
  const marker = `ostia_resized_${Date.now()}`
  seedSettings(dataHome, { ...CANVAS_RENDERER_SETTINGS, appearance: { terminal: { size: 8 } } })

  const first = await launchWindow(dataHome)
  try {
    await setWindowSize(first, 1580, 950)
    await openWorkspace(first.win)
    await wobbleWidth(first)
    await first.win.locator('.ghostty-host').first().click()
    await waitForTerminalFocus(first.win)
    await first.win.keyboard.type(`printf '${marker}_%s\\n' 1 2`)
    await first.win.keyboard.press('Enter')
    await expect(first.win.locator('.terminal-text').first()).toContainText(`${marker}_2`, {
      timeout: 15_000,
    })
    await wobbleWidth(first)
    await first.win.keyboard.type(`echo ${marker}_end_$((20+22))`)
    await first.win.keyboard.press('Enter')
    await expect(first.win.locator('.terminal-text').first()).toContainText(
      new RegExp(`${marker}_end_42[^❯]*❯`),
      { timeout: 15_000 },
    )
  } finally {
    await quitApp(first.app)
  }

  const second = await launchWindow(dataHome)
  try {
    await setWindowSize(second, 1000, 980)
    await expect(second.win.locator('.terminal-text').first()).toContainText('workspace restored', {
      timeout: 15_000,
    })
    await waitForShellPrompt(second.win)
    await second.win.locator('.ghostty-host').first().click()
    await second.win.keyboard.type(`echo ${marker}_flush_$((20+22))`)
    await second.win.keyboard.press('Enter')
    await expect(second.win.locator('.terminal-text').first()).toContainText(`${marker}_flush_42`, {
      timeout: 15_000,
    })

    await expect.poll(async () => promptsAfterSeam(await paneLines(second.win))).toBe(2)

    const lines = await paneLines(second.win)
    const seams = lines.flatMap((l, i) => (l.includes('workspace restored') ? [i] : []))
    expect(seams).toHaveLength(1)
    const [seam] = seams
    expect(lines.some((l) => l.trim() === '%')).toBe(false)
    expect(lines.slice(0, seam).join('\n')).toContain(`${marker}_1`)
    const history = lines.slice(0, seam).filter((l) => l.trim() !== '')
    expect(history[history.length - 1]).toBe(`${marker}_end_42`)
    expect(history).toContain(`${marker}_2`)
    expect(history.filter((l) => l.includes(`printf '${marker}`))).toHaveLength(1)
  } finally {
    await quitApp(second.app)
  }
})
