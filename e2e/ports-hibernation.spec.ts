import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DOM_RENDERER_SETTINGS,
  HIBERNATE_FAST,
  freshDataHome,
  isolatedLaunch,
  seedSettings,
} from './dataHome'
import { extensionHosts } from './extensionHosts'
import { PROMPT, openWorkspace, runInTerminal, shownTerminal } from './helpers'
import { freePort } from './sandboxShell'
import { _electron as electron, expect, test } from './test'

function launchIn(dataHome: string, bin?: string) {
  const home = join(dataHome, 'home')
  mkdirSync(home, { recursive: true })
  const launch = isolatedLaunch(dataHome)
  const path = bin ? `${bin}:${launch.env.PATH ?? ''}` : (launch.env.PATH ?? '')
  return electron.launch({ ...launch, env: { ...launch.env, HOME: home, PATH: path } })
}

test('a port a terminal listens on shows in the top bar and opens in the browser pane', async () => {
  const dataHome = freshDataHome()
  const port = await freePort()
  const app = await launchIn(dataHome)
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await runInTerminal(win, `python3 -m http.server ${port} --bind 127.0.0.1`, shownTerminal(win))

    const chip = win
      .locator('.topbar-right .workspace-chips')
      .getByRole('button', { name: 'Listening ports: 1. Click to list them.' })
    await expect(chip).toBeVisible({ timeout: 20_000 })
    expect(extensionHosts(app)).not.toContain('ports')
    await chip.click()
    await win
      .getByRole('button', { name: `Open http://localhost:${port}/ in the browser pane` })
      .click()

    await expect(win.locator('.pane-tab .title').filter({ hasText: /./ })).toHaveCount(2, {
      timeout: 15_000,
    })
    await expect
      .poll(
        () =>
          app.evaluate(({ webContents }) =>
            webContents
              .getAllWebContents()
              .filter((wc) => wc.getType() === 'webview')
              .map((wc) => wc.getURL()),
          ),
        { timeout: 15_000 },
      )
      .toContain(`http://localhost:${port}/`)
    expect(extensionHosts(app)).not.toContain('ports')

    await win.getByRole('tablist').getByRole('tab').first().click()
    await win.locator('.xterm').first().click()
    await win.keyboard.press('Control+c')
    await expect(win.locator('.xterm-rows').first()).toContainText('Keyboard interrupt', {
      timeout: 10_000,
    })
    await expect(chip).toHaveCount(0, { timeout: 20_000 })
  } finally {
    await app.close()
  }
})

test('an idle hidden agent hibernates and resumes when the human opens its tab', async () => {
  test.setTimeout(90_000)
  const dataHome = freshDataHome()
  const bin = join(dataHome, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\necho "fake agent up: $*"\nexec sleep 600\n')
  chmodSync(join(bin, 'claude'), 0o755)
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    agents: { hibernation: HIBERNATE_FAST },
  })
  const app = await launchIn(dataHome, bin)
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)

    await runInTerminal(
      win,
      'ostia resume-token claude e2e-tok-1 && echo token-$((6*7))',
      shownTerminal(win),
    )
    await expect(win.locator('.xterm-rows').first()).toContainText('token-42', {
      timeout: 15_000,
    })
    await runInTerminal(win, 'claude', shownTerminal(win))
    await expect(win.locator('.xterm-rows').first()).toContainText('fake agent up:', {
      timeout: 15_000,
    })

    await win.getByRole('button', { name: 'New terminal tab' }).click()
    await expect(win.getByRole('tab')).toHaveCount(2)
    await expect(win.locator('.pane-slot:not([data-hidden]) .xterm-rows')).toContainText(PROMPT, {
      timeout: 15_000,
    })

    const sleeping = win.getByRole('tab').first()
    await expect(sleeping.getByLabel('Hibernated')).toBeVisible({ timeout: 30_000 })
    await expect(win.locator('.terminal-surface .xterm')).toHaveCount(1)

    await sleeping.click()

    const rows = win.locator('.pane-slot:not([data-hidden]) .xterm-rows')
    await expect(rows).toContainText('woke from hibernation', { timeout: 15_000 })
    await expect(rows).toContainText('fake agent up:')
    await expect(rows).toContainText(/fake agent up: .*--resume e2e-tok-1/, { timeout: 15_000 })
    await expect(win.locator('.hibernated-view')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('a hibernated agent is still hibernated after a restart and wakes when the human opens its tab', async () => {
  test.setTimeout(120_000)
  const dataHome = freshDataHome()
  const bin = join(dataHome, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\necho "fake agent up: $*"\nexec sleep 600\n')
  chmodSync(join(bin, 'claude'), 0o755)
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    agents: {
      autoResume: true,
      hibernation: HIBERNATE_FAST,
    },
  })
  const first = await launchIn(dataHome, bin)
  try {
    const win = await first.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await runInTerminal(
      win,
      'ostia resume-token claude e2e-tok-2 && echo token-$((6*7))',
      shownTerminal(win),
    )
    await expect(win.locator('.xterm-rows').first()).toContainText('token-42', {
      timeout: 15_000,
    })
    await runInTerminal(win, 'claude', shownTerminal(win))
    await expect(win.locator('.xterm-rows').first()).toContainText('fake agent up:', {
      timeout: 15_000,
    })
    await win.getByRole('button', { name: 'New terminal tab' }).click()
    await expect(win.getByRole('tab')).toHaveCount(2)
    await expect(win.getByRole('tab').first().getByLabel('Hibernated')).toBeVisible({
      timeout: 30_000,
    })
    const saved = (): boolean => {
      try {
        return /"hibernated":\s*true/.test(
          readFileSync(join(dataHome, 'ostia', 'workspaces.json'), 'utf8'),
        )
      } catch {
        return false
      }
    }
    await expect.poll(saved, { timeout: 15_000 }).toBe(true)
  } finally {
    await first.close()
  }

  const second = await launchIn(dataHome, bin)
  try {
    const win = await second.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    const sleeping = win.getByRole('tab').first()
    await expect(sleeping.getByLabel('Hibernated')).toBeVisible({ timeout: 20_000 })
    await expect(win.locator('.pane-slot:not([data-hidden]) .xterm-rows')).toContainText(PROMPT, {
      timeout: 15_000,
    })
    await expect(win.locator('.terminal-surface .xterm')).toHaveCount(1)

    await sleeping.click()
    const rows = win.locator('.pane-slot:not([data-hidden]) .xterm-rows')
    await expect(rows).toContainText(/fake agent up: .*--resume e2e-tok-2/, { timeout: 20_000 })
    await expect(win.locator('.hibernated-view')).toHaveCount(0)
  } finally {
    await second.close()
  }
})
