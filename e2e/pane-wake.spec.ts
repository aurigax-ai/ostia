import { type Page, _electron as electron, expect, test } from '@playwright/test'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { fakeAgentBin, isolatedHome } from './fakeAgent'
import { PROMPT, openWorkspace } from './helpers'

const RESUMABLE_AGENT = [
  '#!/bin/sh',
  'ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" "$OSTIA_CLI" resume-token claude e2e-wake',
  'echo "fake agent up: $*"',
  'exec sleep 600',
  '',
].join('\n')

async function typeLine(win: Page, line: string): Promise<void> {
  await win.keyboard.type(line)
  await win.keyboard.press('Enter')
}

test('an agent wakes a hibernated worker with ostia pane wake and the worker resumes', async () => {
  test.setTimeout(120_000)
  const dataHome = freshDataHome()
  const bin = fakeAgentBin(dataHome, RESUMABLE_AGENT)
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    agents: { hibernation: { enabled: true, idleSeconds: 5, maxLiveTerminals: 0 } },
  })
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...launch,
    env: { ...launch.env, HOME: isolatedHome(dataHome), PATH: `${bin}:${launch.env.PATH ?? ''}` },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    const coordinator = win.locator('.xterm-rows').first()
    await expect(coordinator).toContainText(PROMPT, { timeout: 15_000 })
    await win.locator('.xterm').first().click()

    await typeLine(win, 'ostia agent run claude "fix the login bug" --name fixer')
    const worker = win.getByRole('tab').nth(1)
    await expect(worker.getByLabel('Hibernated')).toBeVisible({ timeout: 45_000 })

    await typeLine(win, 'ostia pane send fixer hello --enter; echo send-exit-$?')
    await expect(coordinator).toContainText('is asleep; wake it with ostia pane wake')
    await expect(coordinator).toContainText('send-exit-1')

    await typeLine(win, `echo asleep-$(ostia pane.list | grep -c '"hibernated": true')`)
    await expect(coordinator).toContainText('asleep-1')

    await typeLine(win, 'ostia pane wake fixer && echo wake-ok')
    await expect(coordinator).toContainText('wake-ok', { timeout: 15_000 })
    await expect(worker.getByLabel('Hibernated')).toHaveCount(0)

    await typeLine(
      win,
      "until ostia pane read fixer | grep -q 'fake agent up: .*--resume e2e-wake'; do sleep 0.5; done; echo resumed-ok",
    )
    await expect(coordinator).toContainText('resumed-ok', { timeout: 30_000 })

    await typeLine(win, 'ostia pane wake fixer; echo again-exit-$?')
    await expect(coordinator).toContainText('not-hibernated')
    await expect(coordinator).toContainText('again-exit-1')
  } finally {
    await app.close()
  }
})
