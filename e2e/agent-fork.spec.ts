import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { fakeAgentBin } from './fakeAgent'
import { openWorkspace, runInTerminal, shownTerminal } from './helpers'
import { _electron as electron, expect, test } from './test'

test.describe.configure({ timeout: 90_000 })

const TOKEN = 'e2e-tok-fork'

test('the fork button starts a fork in a new tab in the agent’s folder and leaves the original alone', async () => {
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  const tree = join(dataHome, 'work', 'fork-tree')
  mkdirSync(tree, { recursive: true })
  mkdirSync(home, { recursive: true })
  const bin = fakeAgentBin(
    dataHome,
    '#!/bin/sh\necho "fake agent up: $* in $(pwd)"\nexec sleep 600\n',
  )
  seedSettings(dataHome, DOM_RENDERER_SETTINGS)
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...launch,
    env: { ...launch.env, HOME: home, PATH: `${bin}:${launch.env.PATH ?? ''}` },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    const payload = JSON.stringify({ session_id: TOKEN, cwd: tree })
    await runInTerminal(
      win,
      `echo '${payload}' | ostia resume-token claude - && echo token-$((6*7))`,
      shownTerminal(win),
    )
    const original = win.locator('.xterm-rows').first()
    await expect(original).toContainText('token-42', { timeout: 15_000 })
    await runInTerminal(win, 'claude', shownTerminal(win))
    await expect(original).toContainText('fake agent up:', { timeout: 15_000 })
    await expect(win.getByRole('tab')).toHaveCount(1)

    await win.getByRole('button', { name: 'Fork conversation into a new tab' }).click()

    await expect(win.getByRole('tab')).toHaveCount(2)
    const fork = win.locator('.pane-slot:not([data-hidden]) .xterm-rows')
    await expect(fork).toContainText(
      new RegExp(`fake agent up: .*--resume ${TOKEN} --fork-session.* in \\S*fork-tree`),
      { timeout: 20_000 },
    )
    await expect(win.getByRole('tab').nth(1)).toContainText('Fork of')
    await expect(win.getByRole('tab').nth(1)).toHaveAttribute('aria-selected', 'true')

    await win.getByRole('tab').first().click()
    const shown = win.locator('.pane-slot:not([data-hidden]) .xterm-rows')
    await expect(shown).toContainText('fake agent up:')
    await expect(shown).not.toContainText('fork-session')
    await expect(win.getByRole('button', { name: /Claude Code session/ })).toBeVisible()
  } finally {
    await app.close()
  }
})
