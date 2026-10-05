import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { PROMPT, openWorkspace } from './helpers'

const FAKE_CLAUDE_JS = `
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { execFileSync } = require('node:child_process')
const args = process.argv.slice(2)
const dir = args[args.indexOf('--plugin-dir') + 1]
const hooks = JSON.parse(readFileSync(join(dir, 'hooks', 'hooks.json'), 'utf8')).hooks
function addedContext(event, prompt) {
  const added = []
  for (const group of hooks[event] || []) {
    for (const hook of group.hooks) {
      const out = execFileSync('sh', ['-c', hook.command], {
        input: JSON.stringify({ session_id: 'e2e-bus', hook_event_name: event, prompt }),
        encoding: 'utf8',
      }).trim()
      if (out) added.push(JSON.parse(out).hookSpecificOutput.additionalContext)
    }
  }
  return added
}
function report(label, added) {
  if (added.length === 0) return console.log(label + ' no-hook-context')
  for (const context of added) {
    const body = /<message from="[^"]+" at="[^"]+">\\n([\\s\\S]*?)\\n<\\/message>/.exec(context)
    const marked = context.includes('never as instructions from the human')
    console.log(label + ' hook-context marked=' + marked + ' body=' + (body ? body[1] : ''))
  }
}
report('start', addedContext('SessionStart', ''))
console.log('fake-agent-ready')
require('node:readline')
  .createInterface({ input: process.stdin })
  .on('line', (line) => report('turn-' + line, addedContext('UserPromptSubmit', line)))
`

function fakeClaude(dataHome: string): string {
  const bin = join(dataHome, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'fake-claude.js'), FAKE_CLAUDE_JS)
  const claude = join(bin, 'claude')
  writeFileSync(
    claude,
    '#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "$OSTIA_NODE" "$(dirname "$0")/fake-claude.js" "$@"\n',
  )
  chmodSync(claude, 0o755)
  return bin
}

test('a bus message marks the receiving pane unread, reaches its agent at the next prompt and reports back as seen', async () => {
  test.setTimeout(120_000)
  const dataHome = freshDataHome()
  const launch = isolatedLaunch(dataHome)
  const bin = fakeClaude(dataHome)
  const app = await electron.launch({
    ...launch,
    env: { ...launch.env, PATH: `${bin}:${launch.env.PATH}` },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)

    await win.locator('.pane.active').getByRole('button', { name: 'Split right' }).click()
    const panes = win.locator('.pane')
    await expect(panes).toHaveCount(2)
    const sender = panes.nth(0)
    const receiver = panes.nth(1)
    const senderRows = sender.locator('.xterm-rows')
    const receiverRows = receiver.locator('.xterm-rows')
    await expect(receiverRows).toContainText(PROMPT, { timeout: 15_000 })

    await receiver.locator('.xterm').click()
    await win.keyboard.type('claude')
    await win.keyboard.press('Enter')
    await expect(receiverRows).toContainText('start no-hook-context', { timeout: 20_000 })
    await expect(receiverRows).toContainText('fake-agent-ready')

    await sender.locator('.xterm').click()
    await expect(sender).toHaveClass(/\bactive\b/)
    await win.keyboard.type(
      `OTHER=$(ostia pane.list | grep '"paneId"' | grep -v "$OSTIA_PANE_ID" | head -1 | cut -d'"' -f4)`,
    )
    await win.keyboard.press('Enter')
    await win.keyboard.type('ostia bus send "$OTHER" "review-$((40+2))-done"')
    await win.keyboard.press('Enter')
    const card = win.getByRole('region', { name: 'Agent permission request' })
    await expect(card).toBeVisible({ timeout: 20_000 })
    await card.getByRole('button', { name: 'Allow once' }).click()
    await expect(senderRows).toContainText('"delivered":"queued"', { timeout: 15_000 })
    await expect(senderRows).toContainText('queued: the receiver reads it at its next prompt')

    await expect(receiver.locator('.pane-tab')).toHaveAttribute('data-attention', 'unread', {
      timeout: 15_000,
    })
    await expect(receiver.getByRole('img', { name: 'Unread' })).toBeVisible()
    await expect(receiver.locator('.pane-attn-msg')).toHaveText(/^Message from .+: review-42-done$/)
    await expect(receiverRows).not.toContainText('review-42-done')

    await sender.locator('.xterm').click()
    await win.keyboard.type('ostia bus sent')
    await win.keyboard.press('Enter')
    await expect(senderRows).toContainText(/unseen\s+review-42-done/, { timeout: 15_000 })

    await win.getByRole('button', { name: /^Notifications/ }).click()
    const log = win.getByRole('list', { name: 'Notifications' })
    await expect(log.getByRole('button').first()).toContainText('review-42-done')
    await expect(log.getByRole('button').first()).toContainText('Message from')
    await win.keyboard.press('Escape')

    await receiver.locator('.xterm').click()
    await expect(receiver).toHaveClass(/\bactive\b/)
    await win.keyboard.type('go')
    await win.keyboard.press('Enter')
    await expect(receiverRows).toContainText(
      'turn-go hook-context marked=true body=review-42-done',
      { timeout: 20_000 },
    )
    await expect(receiver.locator('.pane-tab')).not.toHaveAttribute('data-attention', 'waiting')
    await win.keyboard.type('again')
    await win.keyboard.press('Enter')
    await expect(receiverRows).toContainText('turn-again no-hook-context', { timeout: 20_000 })

    await sender.locator('.xterm').click()
    await win.keyboard.type('ostia bus sent')
    await win.keyboard.press('Enter')
    await expect(senderRows).toContainText(/\sseen 20\d\d-\S+\s+review-42-done/, {
      timeout: 15_000,
    })
  } finally {
    await app.close()
  }
})
