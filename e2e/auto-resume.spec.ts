import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'

function seedAgentTabs(dataHome: string): void {
  mkdirSync(join(dataHome, 'pine'), { recursive: true })
  const tab = (id: string, resumeId: string) => ({
    type: 'pane',
    id,
    title: 'claude',
    kind: 'terminal',
    cwd: dataHome,
    resume: { agent: 'claude', id: resumeId },
    agentRunning: true,
  })
  writeFileSync(
    join(dataHome, 'pine', 'workspaces.json'),
    JSON.stringify({
      v: 1,
      savedAt: new Date().toISOString(),
      activeWorkspaceId: 's1',
      groups: [],
      workspaces: [
        {
          id: 's1',
          name: 'agents',
          kind: 'terminal',
          workDir: dataHome,
          root: {
            type: 'tabs',
            id: 'tabs-1',
            activeId: 'pane-1',
            children: [tab('pane-1', 'front-1111'), tab('pane-2', 'back-2222')],
          },
          activePaneId: 'pane-1',
        },
      ],
    }),
  )
}

function launchWithFakeClaude(dataHome: string) {
  const bin = join(dataHome, 'bin')
  mkdirSync(bin, { recursive: true })
  const claude = join(bin, 'claude')
  writeFileSync(claude, '#!/bin/sh\necho "fake claude $*"\n')
  chmodSync(claude, 0o755)
  const home = join(dataHome, 'home')
  mkdirSync(home, { recursive: true })
  const launch = isolatedLaunch(dataHome)
  return electron.launch({
    ...launch,
    env: { ...launch.env, HOME: home, PATH: `${bin}:${launch.env.PATH}` },
  })
}

test('with auto-resume on, the shown tab resumes its agent and a background tab waits until opened', async () => {
  const dataHome = freshDataHome()
  seedSettings(dataHome, { ...DOM_RENDERER_SETTINGS, agents: { autoResume: true } })
  seedAgentTabs(dataHome)
  const app = await launchWithFakeClaude(dataHome)
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    const shown = win.locator('.pane-slot:not([data-hidden]) .xterm-rows')
    await expect(shown).toContainText('claude --resume front-1111', { timeout: 20_000 })
    await expect(shown).toContainText('fake claude', { timeout: 10_000 })
    await expect(win.locator('.xterm-rows').filter({ hasText: 'back-2222' })).toHaveCount(0)

    await win.getByRole('tab').nth(1).click()
    await expect(shown).toContainText('claude --resume back-2222', { timeout: 20_000 })
  } finally {
    await app.close()
  }
})

test('with auto-resume off, a restored agent tab only offers the Resume button', async () => {
  const dataHome = freshDataHome()
  seedSettings(dataHome, DOM_RENDERER_SETTINGS)
  seedAgentTabs(dataHome)
  const app = await launchWithFakeClaude(dataHome)
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await expect(win.getByRole('button', { name: /Resume claude/ })).toBeVisible({
      timeout: 20_000,
    })
    await expect(win.locator('.pane-slot:not([data-hidden]) .xterm-rows')).toContainText(/[❯$%#]/, {
      timeout: 15_000,
    })
    await expect(win.locator('.xterm-rows').filter({ hasText: 'claude --resume' })).toHaveCount(0)
  } finally {
    await app.close()
  }
})
