import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chords } from './chords'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { PROMPT, emptyState, openWorkspace, quitApp } from './helpers'
import { type ElectronApplication, type Page, _electron as electron, expect, test } from './test'

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
  await expect(win.locator('.xterm-rows').first()).toContainText(PROMPT, { timeout: 15_000 })
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

let dataHome: string

test.beforeEach(() => {
  dataHome = freshDataHome()
})

test(
  'restores the pane layout and terminal history after a restart',
  { tag: '@core' },
  async () => {
    const marker = `ostia_restore_${Date.now()}`

    const first = await launchApp(dataHome)
    try {
      await openWorkspace(first.win)
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

    const snapshotFile = join(dataHome, 'ostia', 'workspaces.json')
    const scrollbackFile = join(dataHome, 'ostia', 'scrollback.json')
    expect(existsSync(snapshotFile), 'workspace snapshot was not written at quit').toBe(true)
    expect(existsSync(scrollbackFile), 'scrollback was not written at quit').toBe(true)
    expect(readFileSync(scrollbackFile, 'utf8')).toContain(marker)

    const second = await launchApp(dataHome)
    try {
      await expect(second.win.locator('.pane')).toHaveCount(2, { timeout: 15_000 })
      await expect(second.win.locator('.workzone')).toContainText(marker, { timeout: 15_000 })
      await expect(second.win.locator('.workzone')).toContainText('workspace restored', {
        timeout: 15_000,
      })
    } finally {
      await quitApp(second.app)
    }
  },
)

test('restores terminal history after a crash (no before-quit)', { tag: '@core' }, async () => {
  const marker = `ostia_crash_${Date.now()}`
  const first = await launchApp(dataHome)
  try {
    await openWorkspace(first.win)
    await first.win.locator('.xterm').first().click()
    await waitForTerminalFocus(first.win)
    await first.win.keyboard.type(`echo ${marker}`)
    await first.win.keyboard.press('Enter')
    await expect(first.win.locator('.xterm-rows').first()).toContainText(marker, {
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
  const marker = `ostia_resized_${Date.now()}`
  seedSettings(dataHome, { ...DOM_RENDERER_SETTINGS, appearance: { terminal: { size: 8 } } })

  const first = await launchApp(dataHome)
  try {
    await setWindowSize(first.app, 1580, 950)
    await openWorkspace(first.win)
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
    await expect(second.win.locator('.xterm-rows').first()).toContainText('workspace restored', {
      timeout: 15_000,
    })
    await waitForShellPrompt(second.win)
    await second.win.waitForTimeout(2_000)

    const lines = await paneLines(second.win)
    const seams = lines.flatMap((l, i) => (l.includes('workspace restored') ? [i] : []))
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

test('adds no seam to a pane left unused across restarts', async () => {
  test.setTimeout(120_000)
  const marker = `ostia_unused_${Date.now()}`
  seedSettings(dataHome, DOM_RENDERER_SETTINGS)

  const first = await launchApp(dataHome)
  try {
    await openWorkspace(first.win)
    await first.win.locator('.xterm').first().click()
    await waitForTerminalFocus(first.win)
    await first.win.keyboard.type(`echo ${marker}`)
    await first.win.keyboard.press('Enter')
    await expect(first.win.locator('.xterm-rows').first()).toContainText(marker, {
      timeout: 15_000,
    })
  } finally {
    await quitApp(first.app)
  }

  const scrollbackFile = join(dataHome, 'ostia', 'scrollback.json')
  for (let restart = 0; restart < 2; restart++) {
    const idle = await launchApp(dataHome)
    try {
      await expect(idle.win.locator('.xterm-rows').first()).toContainText('workspace restored', {
        timeout: 15_000,
      })
      await waitForShellPrompt(idle.win)
    } finally {
      await quitApp(idle.app)
    }
    const saved = readFileSync(scrollbackFile, 'utf8')
    expect(saved).toContain(marker)
    expect(saved).not.toContain('workspace restored')
  }

  const last = await launchApp(dataHome)
  try {
    await expect(last.win.locator('.xterm-rows').first()).toContainText('workspace restored', {
      timeout: 15_000,
    })
    await waitForShellPrompt(last.win)
    const lines = await paneLines(last.win)
    expect(lines.filter((l) => l.includes('workspace restored'))).toHaveLength(1)
    expect(lines.filter((l) => l.includes(`echo ${marker}`))).toHaveLength(1)
  } finally {
    await quitApp(last.app)
  }
})

test('boots with no workspaces when there is nothing to restore', async () => {
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

test('restores zero workspaces after the last workspace was closed', async () => {
  const first = await launchApp(dataHome)
  try {
    await openWorkspace(first.win)
    const tab = first.win.locator('.rail-tab')
    await tab.hover()
    await tab.getByRole('button', { name: 'Close' }).click()
    await expect(emptyState(first.win)).toBeVisible({ timeout: 5_000 })
    await expect
      .poll(
        () => {
          const file = join(dataHome, 'ostia', 'workspaces.json')
          return existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).workspaces.length
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

test('erases stored history when workspace restore is switched off', async () => {
  const first = await launchApp(dataHome)
  try {
    await openWorkspace(first.win)
  } finally {
    await quitApp(first.app)
  }
  expect(existsSync(join(dataHome, 'ostia', 'workspaces.json'))).toBe(true)

  const second = await launchApp(dataHome)
  try {
    await waitForShellPrompt(second.win)
    await second.win.keyboard.press(chords.openSettings)
    const settings = second.win.getByRole('region', { name: 'Settings' })
    await expect(settings).toBeVisible({ timeout: 10_000 })
    await settings.getByRole('button', { name: 'Terminal', exact: true }).click()

    const toggle = settings.getByLabel('Restore workspace on launch')
    await expect(toggle).toBeVisible({ timeout: 10_000 })
    await toggle.click()

    await expect
      .poll(() => existsSync(join(dataHome, 'ostia', 'workspaces.json')), { timeout: 10_000 })
      .toBe(false)
  } finally {
    await quitApp(second.app)
  }
})

test('restores tabs and offers to resume the agent a tab was running', async () => {
  const first = await launchApp(dataHome)
  try {
    await openWorkspace(first.win)
    await first.win.getByRole('button', { name: 'New terminal tab' }).click()
    await expect(first.win.getByRole('tab')).toHaveCount(2)
    await expect(first.win.locator('.pane-slot:not([data-hidden]) .xterm-rows')).toContainText(
      PROMPT,
      { timeout: 15_000 },
    )

    const term = first.win.locator('.pane-slot:not([data-hidden]) .xterm')
    await term.click()
    await waitForTerminalFocus(first.win)
    await first.win.keyboard.type(
      'ostia resume-token claude ffe55127-cb1f-4efd && echo token-$((6*7))',
    )
    await first.win.keyboard.press('Enter')
    await expect(first.win.locator('.pane-slot:not([data-hidden]) .xterm-rows')).toContainText(
      'token-42',
      { timeout: 15_000 },
    )
  } finally {
    await quitApp(first.app)
  }

  const saved = JSON.parse(readFileSync(join(dataHome, 'ostia', 'workspaces.json'), 'utf8'))
  expect(saved.workspaces[0].root).toMatchObject({ type: 'tabs' })

  const second = await launchApp(dataHome)
  try {
    await expect(second.win.getByRole('tab')).toHaveCount(2, { timeout: 15_000 })
    await expect(second.win.locator('.pane-slot:not([data-hidden]) .xterm-rows')).toContainText(
      /workspace restored ──[\s\S]*[❯$%#]/,
      { timeout: 15_000 },
    )
    await second.win.keyboard.press(chords.resumeAgent)
    await expect(second.win.locator('.pane-slot:not([data-hidden]) .xterm-rows')).toContainText(
      'claude --resume ffe55127-cb1f-4efd',
      { timeout: 15_000 },
    )
  } finally {
    await quitApp(second.app)
  }
})

test('keeps an emptied, renamed workspace across a restart', async () => {
  const first = await launchApp(dataHome)
  try {
    await openWorkspace(first.win)
    await first.win.getByRole('button', { name: 'Close tab' }).click()
    await expect(first.win.locator('.xterm')).toHaveCount(0)
    await expect(
      first.win.locator('.workspace-empty:visible').getByRole('button', { name: 'New terminal' }),
    ).toBeVisible()

    await first.win.locator('.rail-tab-main').first().dblclick()
    const name = first.win.getByRole('textbox', { name: 'Workspace name' })
    await name.fill('payments')
    await name.press('Enter')
    await expect(first.win.locator('.rail-tab .tab-title')).toHaveText('payments')
  } finally {
    await quitApp(first.app)
  }

  const second = await launchApp(dataHome)
  try {
    await expect(second.win.locator('.rail-tab .tab-title')).toHaveText('payments', {
      timeout: 15_000,
    })
    await expect(
      second.win.locator('.workspace-empty:visible').getByRole('button', { name: 'New terminal' }),
    ).toBeVisible()
    await expect(second.win.locator('.xterm')).toHaveCount(0)
  } finally {
    await quitApp(second.app)
  }
})
