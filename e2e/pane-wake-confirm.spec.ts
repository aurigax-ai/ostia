import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { fakeAgentBin, isolatedHome } from './fakeAgent'
import { expectHeld, openWorkspace, typeLine } from './helpers'
import { type Page, _electron as electron, expect, test } from './test'

const REPORT = 'ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" "$OSTIA_CLI" resume-token claude e2e-wake'

function agentScript(marker: string, onResume: string): string {
  return [
    '#!/bin/sh',
    `if [ -e "${marker}" ]; then`,
    onResume,
    'fi',
    `touch "${marker}"`,
    `${REPORT} >/dev/null 2>&1`,
    'echo first-start-ready',
    'exec sleep 600',
    '',
  ].join('\n')
}

const EXITS_AT_ONCE = ['  echo refused-at-once', '  exit 1'].join('\n')

function reportsOnceGated(gate: string): string {
  return [
    `  touch "${gate}.waiting"`,
    `  while [ ! -e "${gate}" ]; do sleep 0.1; done`,
    `  ${REPORT} >/dev/null 2>&1`,
    '  sleep 2',
    '  echo resumed-ready',
    '  exec sleep 600',
  ].join('\n')
}

async function hibernateWorker(win: Page): Promise<void> {
  const caller = win.locator('.terminal-text').first()
  await win.locator('.ghostty-host').first().click()
  await typeLine(win, 'ostia agent run claude go --name worker; echo run-exit-$?')
  await expect(caller).toContainText('run-exit-0', { timeout: 30_000 })
  await typeLine(win, 'ostia pane hibernate worker; echo sleep-exit-$?')
  await expect(caller).toContainText('sleep-exit-0', { timeout: 30_000 })
}

async function launch(script: (marker: string) => string) {
  const dataHome = freshDataHome()
  const bin = fakeAgentBin(dataHome, script(join(dataHome, 'second-start')))
  const options = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...options,
    env: {
      ...options.env,
      HOME: isolatedHome(dataHome),
      PATH: `${bin}:${options.env.PATH ?? ''}`,
    },
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await openWorkspace(win)
  return { app, win }
}

test(
  'ostia pane wake answers not-started and shows the failed-resume notice when the agent exits at once',
  { tag: '@core' },
  async () => {
    test.setTimeout(120_000)
    const { app, win } = await launch((marker) => agentScript(marker, EXITS_AT_ONCE))
    try {
      const caller = win.locator('.terminal-text').first()
      await hibernateWorker(win)
      await typeLine(win, 'ostia pane wake worker; echo wake-exit-$?')
      await expect(caller).toContainText('wake-exit-1', { timeout: 30_000 })
      await expect(caller).toContainText('not-started:')
      await expect(caller).toContainText('exited with code 1')
      await win.locator('.pane-tab').last().click()
      await expect(win.locator('[data-resume-failed]')).toBeVisible({ timeout: 15_000 })
    } finally {
      await app.close()
    }
  },
)

test(
  'ostia pane wake answers ok only after the agent reported its start',
  { tag: '@core' },
  async () => {
    test.setTimeout(120_000)
    const gate = join(freshDataHome(), 'report-now')
    const { app, win } = await launch((marker) => agentScript(marker, reportsOnceGated(gate)))
    try {
      const caller = win.locator('.terminal-text').first()
      await hibernateWorker(win)
      await typeLine(
        win,
        'ostia pane wake worker; echo wake-exit-$?; until ostia pane read worker | grep -q resumed-ready; do sleep 0.2; done; echo worker-shows-ready-$?',
      )
      await expect(caller).toContainText('ostia pane wake worker')
      await expect.poll(() => existsSync(`${gate}.waiting`), { timeout: 30_000 }).toBe(true)
      await expectHeld(async () => (await caller.innerText()).includes('wake-exit-0'), false, 500)
      writeFileSync(gate, '')
      await expect(caller).toContainText('wake-exit-0', { timeout: 30_000 })
      await expect(caller).toContainText('worker-shows-ready-0', { timeout: 30_000 })
    } finally {
      await app.close()
    }
  },
)
