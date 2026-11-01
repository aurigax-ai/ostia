import { CANVAS_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { fakeAgentBin } from './fakeAgent'
import { openWorkspace, quitApp, runInTerminal, shownTerminal } from './helpers'
import { _electron as electron, expect, test } from './test'

test.describe.configure({ timeout: 150_000 })

const TOPIC = 'fix the cart total'

const OSTIA = 'ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" "$OSTIA_CLI"'

const FAKE_CLAUDE = [
  '#!/bin/sh',
  'session="cafe0000-$$-0000"',
  `${OSTIA} resume-token claude "$session" >/dev/null 2>&1`,
  'for arg; do case "$arg" in *"handoff intake"*) prompt=$arg;; esac; done',
  'if [ -n "$prompt" ]; then',
  '  echo "fake-prompt: $prompt"',
  '  ticket=$(printf "%s" "$prompt" | sed -n "s/.*intake \\([0-9a-f]*\\).*/\\1/p")',
  `  ${OSTIA} handoff intake "$ticket" | head -4`,
  '  echo fake-intake-done',
  '  exec cat',
  'fi',
  'echo fake-agent-ready',
  'sleep 2',
  `${OSTIA} handoff start "${TOPIC}"`,
  'echo fake-handoff-started',
  'exec cat',
  '',
].join('\n')

test('/handoff opens a new tab beside the caller that follows its intake while the caller stays as it was', async () => {
  const dataHome = freshDataHome()
  seedSettings(dataHome, { ...CANVAS_RENDERER_SETTINGS, playbooks: { enabled: { handoff: true } } })
  const launch = isolatedLaunch(dataHome)
  const bin = fakeAgentBin(dataHome, FAKE_CLAUDE)
  const env = { ...launch.env, PATH: `${bin}:${launch.env.PATH ?? ''}` }
  const app = await electron.launch({ ...launch, env })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await runInTerminal(win, 'claude', shownTerminal(win))
    const tabs = win.locator('.pane-tab')
    await expect(tabs).toHaveCount(2, { timeout: 90_000 })
    await expect(tabs.nth(1).getByRole('tab')).toHaveAttribute('aria-selected', 'true')

    const handed = win.locator('.pane-slot:not([data-hidden]) .terminal-text')
    await expect(handed).toContainText('fake-intake-done', { timeout: 60_000 })
    await expect(win.locator('.pane-slot:not([data-hidden]) .ghostty-host textarea')).toBeFocused()

    await tabs.nth(0).getByRole('tab').click()
    const caller = win.locator('.pane-slot:not([data-hidden]) .terminal-text')
    await expect(caller).toContainText('this session is unchanged', { timeout: 30_000 })
    await expect(caller).toContainText('fake-handoff-started')
    await expect(caller).not.toContainText('fake-prompt')
  } finally {
    await quitApp(app)
  }
})
