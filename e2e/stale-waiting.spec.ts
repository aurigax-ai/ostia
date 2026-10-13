import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { fakeAgentBin, startFakeAgent } from './fakeAgent'
import { openWorkspace } from './helpers'
import { _electron as electron, expect, test } from './test'

const OSTIA_RUN = 'ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" "$OSTIA_CLI"'

function waitingAgent(lateMark: string): string {
  return [
    '#!/bin/sh',
    'echo fake-agent-ready',
    `${OSTIA_RUN} state waiting 'Approve the plan?'`,
    'echo fake-agent-waiting',
    'sleep 4',
    `( sleep 2; ${OSTIA_RUN} state waiting 'late report'; touch '${lateMark}' ) >/dev/null 2>&1 &`,
    'echo fake-agent-gone',
    'exit 0',
    '',
  ].join('\n')
}

test('an agent that waited and then exited leaves the pane idle, and a late report is ignored', async () => {
  test.setTimeout(90_000)
  const dataHome = freshDataHome()
  const lateMark = join(dataHome, 'late-sent')
  const bin = fakeAgentBin(dataHome, waitingAgent(lateMark))
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...launch,
    env: { ...launch.env, PATH: `${bin}:${launch.env.PATH}` },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    const dot = win.locator('.workspace-dot').first()
    const rows = win.locator('.xterm-rows').first()

    await startFakeAgent(win)
    await expect(rows).toContainText('fake-agent-waiting', { timeout: 15_000 })
    await expect(dot).toHaveAttribute('aria-label', 'Waiting for input')

    await expect(rows).toContainText('fake-agent-gone', { timeout: 15_000 })
    await expect(dot).toHaveAttribute('aria-label', 'Idle', { timeout: 10_000 })
    await expect(win.locator('.pane').first().locator('.pane-attn-mark')).toHaveCount(0)

    await expect.poll(() => existsSync(lateMark), { timeout: 15_000 }).toBe(true)
    await win.waitForTimeout(500)
    await expect(dot).toHaveAttribute('aria-label', 'Idle')
    await expect(win.locator('.pane-tab[data-attention="waiting"]')).toHaveCount(0)
  } finally {
    await app.close()
  }
})
