import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Page, _electron as electron, expect, test } from '@playwright/test'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { PROMPT, openWorkspace } from './helpers'

test.describe.configure({ timeout: 90_000 })

async function typeLine(win: Page, line: string): Promise<void> {
  await win.locator('.pane-slot:not([data-hidden]) .xterm').click()
  await win.keyboard.type(line)
  await win.keyboard.press('Enter')
}

async function hibernatedAgentIn(tree: string, token: string) {
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  const bin = join(dataHome, 'bin')
  mkdirSync(tree, { recursive: true })
  mkdirSync(home, { recursive: true })
  mkdirSync(bin, { recursive: true })
  writeFileSync(
    join(bin, 'claude'),
    '#!/bin/sh\necho "fake agent up: $* in $(pwd)"\nexec sleep 600\n',
  )
  chmodSync(join(bin, 'claude'), 0o755)
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    agents: { hibernation: { enabled: true, idleSeconds: 5, maxLiveTerminals: 0 } },
  })
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...launch,
    env: { ...launch.env, HOME: home, PATH: `${bin}:${launch.env.PATH ?? ''}` },
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await openWorkspace(win)
  const payload = JSON.stringify({ session_id: token, cwd: tree })
  await typeLine(win, `echo '${payload}' | ostia resume-token claude -`)
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
  await sleeping.click()
  return { app, win, home }
}

test('a woken agent starts in the folder its session belongs to, not the pane’s folder', async () => {
  const root = freshDataHome()
  const tree = join(root, 'work', 'tree')
  const { app, win } = await hibernatedAgentIn(tree, 'e2e-tok-here')
  try {
    await win.locator('.hibernated-view').getByRole('button', { name: 'Resume claude' }).click()
    const rows = win.locator('.pane-slot:not([data-hidden]) .xterm-rows')
    await expect(rows).toContainText(`--resume e2e-tok-here in ${tree}`, { timeout: 20_000 })
    await expect(win.locator('[data-resume-folder-missing]')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('waking an agent whose folder was removed shows a notice and runs nothing', async () => {
  const root = freshDataHome()
  const tree = join(root, 'work', 'tree')
  const { app, win } = await hibernatedAgentIn(tree, 'e2e-tok-gone')
  try {
    renameSync(tree, join(root, 'work', 'tree-moved'))
    await win.locator('.hibernated-view').getByRole('button', { name: 'Resume claude' }).click()
    const notice = win.getByRole('region', { name: 'Agent folder missing' })
    await expect(notice).toBeVisible({ timeout: 20_000 })
    await expect(notice).toContainText(tree)
    const rows = win.locator('.pane-slot:not([data-hidden]) .xterm-rows')
    await expect(rows).toContainText('woke from hibernation', { timeout: 15_000 })
    await expect(rows).toContainText(PROMPT)
    await win.waitForTimeout(2_000)
    await expect(rows).not.toContainText('claude --resume')
    await expect(rows).not.toContainText('--resume e2e-tok-gone')
    await expect(win.getByRole('button', { name: 'Resume claude' })).toHaveCount(0)
  } finally {
    await app.close()
  }
})
