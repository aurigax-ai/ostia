import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { type Page, _electron as electron, expect, test } from '@playwright/test'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { emptyState, openWorkspace } from './helpers'

async function launch(workspaces: object) {
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  mkdirSync(join(home, 'projects'), { recursive: true })
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    workspaces: { ...DOM_RENDERER_SETTINGS.workspaces, ...workspaces },
  })
  const launchOptions = isolatedLaunch(dataHome)
  const app = await electron.launch({ ...launchOptions, env: { ...launchOptions.env, HOME: home } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await openWorkspace(win)
  await win.locator('.xterm').first().click()
  return { app, win, home }
}

async function startLongCommand(win: Page, marker: string): Promise<void> {
  await win.keyboard.type(`echo ${marker}_$((20+22)); sleep 100`)
  await win.keyboard.press('Enter')
  await expect(win.locator('.xterm-rows').first()).toContainText(`${marker}_42`, {
    timeout: 15_000,
  })
}

async function newWorkspaceFromTopBar(win: Page): Promise<void> {
  await win.locator('.topbar').getByRole('button', { name: 'New workspace' }).click()
}

async function clickCloseOnFirstWorkspace(win: Page): Promise<void> {
  const row = win.locator('.rail-tab').first()
  await row.hover()
  await row.getByRole('button', { name: 'Close', exact: true }).click()
}

test('a new workspace lands at the top when placement is top', async () => {
  test.setTimeout(60_000)
  const { app, win } = await launch({ placement: 'top' })
  try {
    await newWorkspaceFromTopBar(win)
    await expect(win.locator('.rail-tab')).toHaveCount(2)
    await expect(win.locator('.rail-tab').nth(0)).toHaveClass(/active/)
    await expect(win.locator('.rail-tab').nth(1)).not.toHaveClass(/active/)
  } finally {
    await app.close()
  }
})

test('a new workspace starts in the focused pane folder when inheriting', async () => {
  test.setTimeout(60_000)
  const { app, win, home } = await launch({ inheritFolder: true })
  try {
    await win.keyboard.type('cd projects && echo cd_$((20+22))_done')
    await win.keyboard.press('Enter')
    await expect(win.locator('.xterm-rows').first()).toContainText('cd_42_done', {
      timeout: 15_000,
    })
    await win.waitForTimeout(500)

    await newWorkspaceFromTopBar(win)

    await expect(win.locator('.rail-tab')).toHaveCount(2)
    await expect(win.locator('.rail-tab').nth(1).locator('.rail-meta-path')).toHaveText(
      '~/projects',
    )
    await expect(win.locator('.rail-tab').nth(0).locator('.rail-meta-path')).toHaveText(
      '~/projects',
    )
  } finally {
    await app.close()
  }
})

test('closing a workspace with a running command asks first, and Cancel keeps it', async () => {
  test.setTimeout(60_000)
  const { app, win } = await launch({})
  try {
    await startLongCommand(win, 'close')

    await clickCloseOnFirstWorkspace(win)
    const dialog = win.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 5_000 })
    await expect(dialog).toContainText('sleep 100')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(win.locator('.rail-tab')).toHaveCount(1)

    await clickCloseOnFirstWorkspace(win)
    await expect(dialog).toBeVisible({ timeout: 5_000 })
    await dialog.getByRole('button', { name: 'Close workspace' }).click()
    await expect(win.locator('.rail-tab')).toHaveCount(0)
    await expect(emptyState(win)).toBeVisible()
  } finally {
    await app.close()
  }
})

test('quitting with a running command asks first, and Cancel keeps the window open', async () => {
  test.setTimeout(90_000)
  const { app, win } = await launch({ confirmQuit: true })
  try {
    await startLongCommand(win, 'quit')

    await win.evaluate(() => window.ostia.window.quit())
    const dialog = win.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 5_000 })
    await expect(dialog).toContainText('sleep 100')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toHaveCount(0)
    expect(win.isClosed()).toBe(false)
    await expect(win.locator('.xterm').first()).toBeVisible()

    await win.evaluate(() => window.ostia.window.quit())
    await expect(dialog).toBeVisible({ timeout: 5_000 })
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toHaveCount(0)
    expect(win.isClosed()).toBe(false)

    await win.evaluate(() => window.ostia.window.quit())
    await expect(dialog).toBeVisible({ timeout: 5_000 })
    await Promise.all([
      app.waitForEvent('close'),
      dialog.getByRole('button', { name: 'Quit' }).click(),
    ])
  } finally {
    await app.close().catch(() => {})
  }
})
