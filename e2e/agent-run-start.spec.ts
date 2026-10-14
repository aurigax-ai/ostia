import { freshDataHome, isolatedLaunch } from './dataHome'
import { fakeAgentBin, isolatedHome } from './fakeAgent'
import { openWorkspace, typeLine } from './helpers'
import { _electron as electron, expect, test } from './test'

const AGENT = [
  '#!/bin/sh',
  'case "$*" in *crash*) echo "fake agent crashed: no api key"; exit 3 ;; esac',
  'ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" "$OSTIA_CLI" resume-token claude e2e-start',
  'echo fake-agent-ready',
  'exec cat',
  '',
].join('\n')

test(
  'ostia agent run answers failed with the exit code and output when the agent exits at once',
  { tag: '@core' },
  async () => {
    const dataHome = freshDataHome()
    const bin = fakeAgentBin(dataHome, AGENT)
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
      await win.locator('.xterm').first().click()

      await typeLine(win, 'ostia agent run claude crash --name lead; echo crash-exit-$?')
      await expect(coordinator).toContainText('crash-exit-1', { timeout: 30_000 })
      await expect(coordinator).toContainText('"status":"failed"')
      await expect(coordinator).toContainText('"exitCode":3')
      await expect(coordinator).toContainText('fake agent crashed: no api key')

      await typeLine(win, 'ostia agent run claude "fix the bug" --name fixer; echo start-exit-$?')
      await expect(coordinator).toContainText('start-exit-0', { timeout: 30_000 })
      await expect(coordinator).toContainText('"status":"started"')
      await typeLine(win, `echo started-$(ostia pane list | grep -c '"start": "started"')`)
      await expect(coordinator).toContainText('started-1')
    } finally {
      await app.close()
    }
  },
)
