import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { fakeAgentBin, startFakeAgent } from './fakeAgent'
import { openWorkspace } from './helpers'

const PINE = 'ELECTRON_RUN_AS_NODE=1 "$PINE_NODE" "$PINE_CLI"'

function waitingAgent(lateMark: string): string {
  return [
    '#!/bin/sh',
    'echo fake-agent-ready',
    `${PINE} state waiting 'Approve the plan?'`,
    'echo fake-agent-waiting',
    'sleep 4',
    `( sleep 2; ${PINE} state waiting 'late report'; touch '${lateMark}' ) >/dev/null 2>&1 &`,
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

test('a notification from a plain command in zsh is a message, not a wait for input', async () => {
  test.setTimeout(90_000)
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    const dot = win.locator('.workspace-dot').first()

    await win.locator('.xterm').first().click()
    await win.keyboard.type("printf '\\e]9;hello\\a'")
    await win.keyboard.press('Enter')

    const bell = win.getByRole('button', { name: /^Notifications/ })
    await bell.click()
    const list = win.getByRole('list', { name: 'Notifications' })
    await expect(list.getByRole('button').first()).toContainText('hello', { timeout: 10_000 })
    await expect(list).not.toContainText('Agent needs your input')
    await expect(dot).toHaveAttribute('aria-label', 'Idle')
    await expect(win.locator('.pane').first().locator('.pane-attn-mark')).toHaveCount(0)
  } finally {
    await app.close()
  }
})
