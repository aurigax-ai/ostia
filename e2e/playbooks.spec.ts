import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { fakeAgentBin } from './fakeAgent'
import {
  addTab,
  occurrences,
  openWorkspace,
  quitApp,
  runInTerminal,
  shownTerminal,
} from './helpers'
import { _electron as electron, expect, test } from './test'

test.describe.configure({ timeout: 120_000 })

const FAKE_CLAUDE = [
  '#!/bin/sh',
  'for arg; do [ "$prev" = --plugin-dir ] && [ -z "$plugin" ] && plugin=$arg; prev=$arg; done',
  'printf "playbooks:"; for n in onboard handoff; do [ -f "$plugin/skills/$n/SKILL.md" ] && printf "%s," "$n"; done; echo',
  'echo "edited:$(cat "$plugin/skills/onboard/SKILL.md" 2>/dev/null | grep -c E2E-EDIT)"',
  'echo "human-only:$(cat "$plugin/skills/onboard/SKILL.md" 2>/dev/null | grep -c "^disable-model-invocation: true$")"',
  '[ -f "$plugin/skills/onboard/steps/pr.md" ] && echo "steps:1"',
  '',
].join('\n')

test('a playbook turned on and edited in Settings reaches the next terminal’s agent, not a running shell’s', async () => {
  const dataHome = freshDataHome()
  seedSettings(dataHome, DOM_RENDERER_SETTINGS)
  const launch = isolatedLaunch(dataHome)
  const bin = fakeAgentBin(dataHome, FAKE_CLAUDE)
  const env = { ...launch.env, PATH: `${bin}:${launch.env.PATH ?? ''}` }
  const app = await electron.launch({ ...launch, env })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    const rows = win.locator('.xterm-rows').first()

    await runInTerminal(win, 'claude', shownTerminal(win))
    await expect(rows).toContainText('human-only:0', { timeout: 30_000 })
    await expect(rows).toContainText('playbooks:edited:0')

    await win.locator('.topbar').getByRole('button', { name: 'Settings' }).click()
    const settings = win.getByRole('region', { name: 'Settings' })
    await settings.getByRole('button', { name: 'Playbooks' }).click()
    await settings.getByRole('switch', { name: '/onboard' }).click()
    const prompt = settings.getByRole('textbox', { name: '/onboard prompt' })
    await prompt.click()
    await prompt.press('Control+End')
    await win.keyboard.type('\nE2E-EDIT')
    await win.keyboard.press('Tab')
    await expect(settings.getByText('Edited')).toBeVisible()
    await expect
      .poll(
        () => {
          const file = join(dataHome, 'userData', 'settings.json')
          return existsSync(file) ? readFileSync(file, 'utf8') : ''
        },
        { timeout: 15_000 },
      )
      .toContain('E2E-EDIT')
    await win.keyboard.press('Escape')

    await runInTerminal(win, 'claude', shownTerminal(win))
    await expect
      .poll(async () => occurrences((await rows.textContent()) ?? '', 'human-only:0'))
      .toBe(2)
    expect(occurrences((await rows.textContent()) ?? '', 'playbooks:onboard,')).toBe(0)

    await addTab(win)
    await runInTerminal(win, 'claude', shownTerminal(win))
    const fresh = win.locator('.pane-slot:not([data-hidden]) .xterm-rows').last()
    await expect(fresh).toContainText('playbooks:onboard,', { timeout: 30_000 })
    await expect(fresh).toContainText('edited:1')
    await expect(fresh).toContainText('human-only:0')
    await expect(fresh).toContainText('steps:1')
  } finally {
    await quitApp(app)
  }
})
