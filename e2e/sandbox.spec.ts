import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Page, _electron as electron, expect, test } from '@playwright/test'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { openWorkspace } from './helpers'

async function launch() {
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  const project = join(home, 'project')
  mkdirSync(join(home, '.ssh'), { recursive: true })
  mkdirSync(project, { recursive: true })
  writeFileSync(join(home, '.ssh', 'id_ed25519'), 'SECRET-KEY-MATERIAL')
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    workspaces: { ...DOM_RENDERER_SETTINGS.workspaces, defaultFolder: project },
  })
  const launchOptions = isolatedLaunch(dataHome)
  const app = await electron.launch({ ...launchOptions, env: { ...launchOptions.env, HOME: home } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await openWorkspace(win)
  return { app, win, home, project, dataHome }
}

async function run(win: Page, command: string): Promise<void> {
  await win.locator('.xterm').first().click()
  await win.keyboard.type(command)
  await win.keyboard.press('Enter')
}

async function setSandbox(win: Page, on: boolean): Promise<void> {
  await win.locator('.rail-row').first().click({ button: 'right' })
  const item = win.getByRole('menuitemcheckbox', { name: 'Sandbox' })
  await expect(item).toHaveAttribute('aria-checked', on ? 'false' : 'true')
  await item.click()
}

test('SBX-C5 a workspace with the sandbox off spawns an unwrapped shell', async () => {
  const { app, win, home } = await launch()
  try {
    await run(win, `cat ${home}/.ssh/id_ed25519; echo C5-DONE`)
    await expect(win.locator('.xterm-rows').first()).toContainText('SECRET-KEY-MATERIAL', {
      timeout: 15_000,
    })
    await expect(win.getByRole('button', { name: 'Restart to apply' })).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('SBX-C6 turning the sandbox on asks running panes to restart, and the restart sandboxes them', async () => {
  const { app, win, home } = await launch()
  try {
    await setSandbox(win, true)
    const restart = win.getByRole('button', { name: 'Restart to apply' })
    await expect(restart).toBeVisible({ timeout: 10_000 })
    await restart.click()
    await expect(restart).toHaveCount(0)
    await expect(win.locator('.xterm-rows').first()).toContainText(/[❯$%#]/, { timeout: 20_000 })
    await run(win, `cat ${home}/.ssh/id_ed25519 || echo C6-DENIED`)
    await expect(win.locator('.xterm-rows').first()).toContainText('C6-DENIED', {
      timeout: 15_000,
    })
  } finally {
    await app.close()
  }
})

test('SBX-C1 a new pane in a sandboxed workspace runs under srt and cannot read ~/.ssh', async () => {
  const { app, win, home } = await launch()
  try {
    await setSandbox(win, true)
    await win
      .locator('.pane-actions')
      .first()
      .getByRole('button', { name: 'New terminal tab' })
      .click()
    await expect(win.locator('.xterm-rows:visible')).toContainText(/[❯$%#]/, { timeout: 20_000 })
    await win.locator('.xterm:visible').click()
    await win.keyboard.type(
      `cat ${home}/.ssh/id_ed25519 || echo C1-DENIED; echo "proxy=$HTTPS_PROXY"`,
    )
    await win.keyboard.press('Enter')
    const rows = win.locator('.xterm-rows:visible')
    await expect(rows).toContainText('C1-DENIED', { timeout: 15_000 })
    await expect(rows).toContainText('proxy=http://')
    await expect(rows).not.toContainText('SECRET-KEY-MATERIAL')
  } finally {
    await app.close()
  }
})
