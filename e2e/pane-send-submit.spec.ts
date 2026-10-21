import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { fakeAgentBin, isolatedHome } from './fakeAgent'
import { openWorkspace, typeLine } from './helpers'
import { _electron as electron, expect, test } from './test'

const PASTE_SWALLOWING_AGENT = `
const { spawnSync } = require('node:child_process')
const ostia = (...args) =>
  spawnSync(process.env.OSTIA_NODE, [process.env.OSTIA_CLI, ...args], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'ignore',
  })
ostia('resume-token', 'claude', 'e2e-paste')
process.stdout.write('\\x1b[?2004hfake-agent-ready\\r\\n')
process.stdin.setRawMode(true)
let input = ''
let pending = ''
let afterPaste = false
let swallowed = false
process.stdin.on('data', (chunk) => {
  pending += chunk.toString()
  while (pending) {
    if (pending.startsWith('\\x1b[200~')) {
      const end = pending.indexOf('\\x1b[201~')
      if (end < 0) return
      const text = pending.slice(6, end)
      input += text
      process.stdout.write(text.replace(/\\r/g, '\\r\\n'))
      pending = pending.slice(end + 6)
      afterPaste = true
      continue
    }
    const key = pending[0]
    pending = pending.slice(1)
    if (key !== '\\r') {
      input += key
      process.stdout.write(key)
      continue
    }
    if (afterPaste && !swallowed) {
      swallowed = true
      afterPaste = false
      process.stdout.write('\\r\\nswallowed-enter\\r\\n')
      continue
    }
    process.stdout.write(\`\\r\\nsubmitted: \${input.replace(/\\r/g, ' | ')}\\r\\n\`)
    input = ''
    ostia('state', 'working')
  }
})
`

test('ostia pane send answers not-submitted when an agent swallowed the Enter after a paste, and types nothing more', {
  tag: '@core',
}, async () => {
  test.setTimeout(90_000)
  const dataHome = freshDataHome()
  const script = join(dataHome, 'fake-claude.cjs')
  writeFileSync(script, PASTE_SWALLOWING_AGENT)
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
    const caller = win.locator('.xterm-rows').first()
    await win.locator('.xterm').first().click()

    await typeLine(win, 'ostia agent run claude go --name worker; echo run-exit-$?')
    await expect(caller).toContainText('run-exit-0', { timeout: 30_000 })

    await typeLine(
      win,
      "printf 'line one\\nline two' | ostia pane send worker - --enter; echo send-exit-$?",
    )
    await expect(caller).toContainText('send-exit-1', { timeout: 30_000 })
    await expect(caller).toContainText('not-submitted:')
    await typeLine(win, 'clear; ostia pane read worker')
    await expect(caller).toContainText('swallowed-enter', { timeout: 15_000 })
    await expect(caller).not.toContainText('submitted: line one')
  } finally {
    await app.close()
  }
})
