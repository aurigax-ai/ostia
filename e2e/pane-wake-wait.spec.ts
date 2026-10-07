import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { fakeAgentBin, isolatedHome } from './fakeAgent'
import { PROMPT, openWorkspace } from './helpers'
import { type Page, _electron as electron, expect, test } from './test'

const SLOW_AGENT = [
  '#!/bin/sh',
  'case "$*" in *--resume*) sleep 5 ;; esac',
  'ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" "$OSTIA_CLI" resume-token claude e2e-wake-wait',
  'echo "fake agent up: $*"',
  'while read -r line; do echo "agent got: $line"; done',
  'exec sleep 600',
  '',
].join('\n')

async function typeLine(win: Page, line: string): Promise<void> {
  await win.keyboard.type(line)
  await win.keyboard.press('Enter')
}

test('pane wake --wait returns once the woken agent started, and a send before that is refused', async () => {
  test.setTimeout(120_000)
  const dataHome = freshDataHome()
  const bin = fakeAgentBin(dataHome, SLOW_AGENT)
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

    await typeLine(
      win,
      `ostia pane wake fixer; ostia pane send fixer early --enter; echo early-exit-$?; echo waking-$(ostia pane.list | grep -c '"waking": true')`,
    )
    await expect(coordinator).toContainText('is starting its agent', { timeout: 15_000 })
    await expect(coordinator).toContainText('early-exit-1')
    await expect(coordinator).toContainText('waking-1')

    await typeLine(
      win,
      'ostia pane wake fixer --wait && ostia pane send fixer hi --enter && echo sent-ok',
    )
    await expect(coordinator).toContainText('sent-ok', { timeout: 30_000 })

    await typeLine(
      win,
      "until ostia pane read fixer | grep -q 'agent got: hi'; do sleep 0.5; done; echo reached-ok",
    )
    await expect(coordinator).toContainText('reached-ok', { timeout: 15_000 })
    await typeLine(win, `echo early-$(ostia pane read fixer | grep -c 'early')`)
    await expect(coordinator).toContainText('early-0')
    await typeLine(win, `echo waking-after-$(ostia pane.list | grep -c '"waking": true')`)
    await expect(coordinator).toContainText('waking-after-0')
  } finally {
    await app.close()
  }
})
