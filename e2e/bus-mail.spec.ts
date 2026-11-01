import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { fakeAgentBin, isolatedHome } from './fakeAgent'
import { openWorkspace, typeLine } from './helpers'
import { _electron as electron, expect, test } from './test'

const MAIL_AGENT = `
const { spawnSync } = require('node:child_process')
const ostia = (...args) =>
  spawnSync(process.env.OSTIA_NODE, [process.env.OSTIA_CLI, ...args], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
  })
ostia('resume-token', 'claude', 'e2e-mail')
ostia('state', 'done')
process.stdout.write('fake-agent-ready\\r\\n')
process.stdin.setRawMode(true)
process.stdin.on('data', (chunk) => {
  if (!chunk.toString().includes('\\r')) return
  const hook = ostia('bus', 'hook', 'UserPromptSubmit')
  const context = hook.stdout.trim() ? JSON.parse(hook.stdout).hookSpecificOutput.additionalContext : ''
  process.stdout.write('prompt-submitted\\r\\n')
  if (context) process.stdout.write('mail-in-context: ' + context.replace(/\\s+/g, ' ') + '\\r\\n')
  ostia('state', 'done')
})
`

test('a message to an idle agent shows as a mail count until the agent takes it', async () => {
  test.setTimeout(120_000)
  const dataHome = freshDataHome()
  const script = join(dataHome, 'fake-claude.cjs')
  writeFileSync(script, MAIL_AGENT)
  const bin = fakeAgentBin(
    dataHome,
    `#!/bin/sh\nexec env ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" "${script}"\n`,
  )
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...launch,
    env: { ...launch.env, HOME: isolatedHome(dataHome), PATH: `${bin}:${launch.env.PATH ?? ''}` },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    const caller = win.locator('.terminal-text').first()
    await win.locator('.ghostty-host').first().click()

    await typeLine(win, 'ostia agent run claude go --name worker; echo run-exit-$?')
    await expect(caller).toContainText('run-exit-0', { timeout: 30_000 })

    await typeLine(win, 'W=$(ostia process list | awk \'$2=="worker"{print $4}\'); echo worker-$W')
    await expect(caller).toContainText(/worker-[0-9a-f-]{36}/, { timeout: 15_000 })
    await typeLine(win, 'clear; ostia bus send $W "review-42-done" 2>&1; echo send-exit-$?')
    await expect(caller).toContainText('send-exit-0', { timeout: 30_000 })
    await expect(caller).toContainText('"state":"queued"')

    const mark = win
      .getByRole('tab', { name: /worker/ })
      .getByRole('img', { name: '1 unread message for this agent' })
    await expect(mark).toBeVisible({ timeout: 15_000 })

    await typeLine(win, 'clear; ostia pane send worker --enter; echo enter-exit-$?')
    await expect(caller).toContainText('enter-exit-0', { timeout: 30_000 })
    await typeLine(win, 'clear; ostia pane read worker')
    await expect(caller).toContainText('mail-in-context:', { timeout: 20_000 })
    await expect(caller).toContainText('review-42-done')
    await expect(mark).toHaveCount(0, { timeout: 15_000 })

    await typeLine(win, 'clear; ostia bus sent')
    await expect(caller).toContainText('delivered:prompt', { timeout: 15_000 })
  } finally {
    await app.close()
  }
})
