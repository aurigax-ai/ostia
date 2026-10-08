import { mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import {
  DOM_RENDERER_SETTINGS,
  HIBERNATE_FAST,
  freshDataHome,
  isolatedLaunch,
  seedSettings,
} from './dataHome'
import { fakeAgentBin } from './fakeAgent'
import { PROMPT, openWorkspace, runInTerminal, shownTerminal } from './helpers'
import { _electron as electron, expect, test } from './test'

test.describe.configure({ timeout: 90_000 })

async function hibernatedAgentIn(tree: string, token: string) {
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  mkdirSync(tree, { recursive: true })
  mkdirSync(home, { recursive: true })
  const bin = fakeAgentBin(
    dataHome,
    '#!/bin/sh\necho "fake agent up: $* in $(pwd)"\nexec sleep 600\n',
  )
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    agents: { hibernation: HIBERNATE_FAST },
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
  await runInTerminal(
    win,
    `echo '${payload}' | ostia resume-token claude - && echo token-$((6*7))`,
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
  return { app, win, home, sleeping }
}

test('a woken agent starts in the folder its session belongs to, not the pane’s folder', async () => {
  const root = freshDataHome()
  const tree = join(root, 'work', 'tree')
  const { app, win, sleeping } = await hibernatedAgentIn(tree, 'e2e-tok-here')
  try {
    await sleeping.click()
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
  const { app, win, sleeping } = await hibernatedAgentIn(tree, 'e2e-tok-gone')
  try {
    renameSync(tree, join(root, 'work', 'tree-moved'))
    await sleeping.click()
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
