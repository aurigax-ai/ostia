import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { type Page, _electron as electron, expect, test } from '@playwright/test'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { PROMPT, openWorkspace } from './helpers'

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>((r) => server.close(() => r()))
  return port
}

async function typeLine(win: Page, line: string): Promise<void> {
  await win.locator('.pane-slot:not([data-hidden]) .xterm').click()
  await win.keyboard.type(line)
  await win.keyboard.press('Enter')
}

function launchIn(dataHome: string, bin?: string) {
  const home = join(dataHome, 'home')
  mkdirSync(home, { recursive: true })
  const launch = isolatedLaunch(dataHome)
  const path = bin ? `${bin}:${launch.env.PATH ?? ''}` : (launch.env.PATH ?? '')
  return electron.launch({ ...launch, env: { ...launch.env, HOME: home, PATH: path } })
}

test('a port a terminal listens on shows in the sidebar and opens in the browser pane', async () => {
  const dataHome = freshDataHome()
  const port = await freePort()
  const app = await launchIn(dataHome)
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await typeLine(win, `python3 -m http.server ${port} --bind 127.0.0.1`)

    const item = win.locator('.ext-item-link').filter({ hasText: `:${port}` })
    await expect(item).toBeVisible({ timeout: 20_000 })
    await item.click()

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

    await win.locator('.xterm').first().click()
    await win.keyboard.press('Control+c')
    await expect(win.locator('.xterm-rows').first()).toContainText('Keyboard interrupt', {
      timeout: 10_000,
    })
    await expect(item).toHaveCount(0, { timeout: 20_000 })
  } finally {
    await app.close()
  }
})

test('an idle hidden agent hibernates and resumes when the human asks', async () => {
  test.setTimeout(90_000)
  const dataHome = freshDataHome()
  const bin = join(dataHome, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\necho "fake agent up: $*"\nexec sleep 600\n')
  chmodSync(join(bin, 'claude'), 0o755)
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    agents: { hibernation: { enabled: true, idleSeconds: 5, maxLiveTerminals: 0 } },
  })
  const app = await launchIn(dataHome, bin)
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)

    await typeLine(win, 'pine resume-token claude e2e-tok-1')
    await expect(win.getByRole('button', { name: 'Resume claude' })).toBeVisible({
      timeout: 15_000,
    })
    await typeLine(win, 'claude')
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
    await expect(win.locator('.xterm')).toHaveCount(1)

    await sleeping.click()
    const view = win.locator('.hibernated-view')
    await expect(view).toContainText('Hibernated — click to resume')
    await expect(view).toContainText('claude --resume e2e-tok-1')
    await view.getByRole('button', { name: 'Resume claude' }).click()

    const rows = win.locator('.pane-slot:not([data-hidden]) .xterm-rows')
    await expect(rows).toContainText('woke from hibernation', { timeout: 15_000 })
    await expect(rows).toContainText('fake agent up:')
    await expect(rows).toContainText(/fake agent up: .*--resume e2e-tok-1/, { timeout: 15_000 })
    await expect(win.locator('.hibernated-view')).toHaveCount(0)
  } finally {
    await app.close()
  }
})
