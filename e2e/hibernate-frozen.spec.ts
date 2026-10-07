import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type ElectronApplication,
  type Locator,
  type Page,
  _electron as electron,
  expect,
  test,
} from '@playwright/test'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { fakeAgentBin, isolatedHome } from './fakeAgent'
import { PROMPT, openWorkspace } from './helpers'

test.describe.configure({ timeout: 120_000 })

const MARK = 'frozen-screen-381'

const AGENT = [
  '#!/bin/sh',
  'ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" "$OSTIA_CLI" resume-token claude e2e-frozen',
  `echo "${MARK} up $*"`,
  'exec sleep 600',
  '',
].join('\n')

interface Launched {
  app: ElectronApplication
  win: Page
}

async function launch(dataHome: string): Promise<Launched> {
  const bin = fakeAgentBin(dataHome, AGENT)
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
  return { app, win }
}

async function hibernatedAgent(): Promise<Launched & { dataHome: string; sleeping: Locator }> {
  const dataHome = freshDataHome()
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    agents: { hibernation: { enabled: true, idleSeconds: 5, maxLiveTerminals: 0 } },
  })
  const { app, win } = await launch(dataHome)
  await openWorkspace(win)
  await expect(win.locator('.xterm-rows').first()).toContainText(PROMPT, { timeout: 15_000 })
  await win.locator('.xterm').first().click()
  await win.keyboard.type('claude')
  await win.keyboard.press('Enter')
  await expect(win.locator('.xterm-rows').first()).toContainText(`${MARK} up`, {
    timeout: 15_000,
  })
  await win.getByRole('button', { name: 'New terminal tab' }).click()
  const sleeping = win.getByRole('tab').first()
  await expect(sleeping.getByLabel('Hibernated')).toBeVisible({ timeout: 45_000 })
  await sleeping.click()
  return { app, win, dataHome, sleeping }
}

function frozenScreen(win: Page): Locator {
  return win.locator('.pane-slot:not([data-hidden]) .hibernated-view')
}

function count(text: string, part: string): number {
  return text.split(part).length - 1
}

test('a hibernated pane keeps its last screen frozen and read-only, and wakes with one copy of it', async () => {
  const { app, win, sleeping } = await hibernatedAgent()
  try {
    const frozen = frozenScreen(win)
    await expect(frozen.getByText('Asleep')).toBeVisible()
    await expect(frozen.locator('.xterm-rows')).toContainText(`${MARK} up`)
    await frozen.locator('.xterm').click()
    await win.keyboard.type('typed-while-asleep')
    await win.keyboard.press('Enter')
    await win.waitForTimeout(1_000)
    await expect(frozen.locator('.xterm-rows')).not.toContainText('typed-while-asleep')
    await expect(sleeping.getByLabel('Hibernated')).toBeVisible()

    await win.getByRole('button', { name: 'Resume claude' }).click()
    await expect(frozen).toHaveCount(0)
    const rows = win.locator('.pane-slot:not([data-hidden]) .xterm-rows')
    await expect
      .poll(async () => count((await rows.textContent()) ?? '', MARK), { timeout: 20_000 })
      .toBe(2)
    const text = (await rows.textContent()) ?? ''
    expect(count(text, 'woke from hibernation')).toBe(1)
    expect(text.indexOf(MARK)).toBeLessThan(text.indexOf('woke from hibernation'))
    expect(text.indexOf('woke from hibernation')).toBeLessThan(text.lastIndexOf(MARK))
    expect(text).not.toContain('typed-while-asleep')
  } finally {
    await app.close()
  }
})

test('a hibernated pane shows its saved screen after a restart', async () => {
  const first = await hibernatedAgent()
  const saved = join(first.dataHome, 'ostia', 'workspaces.json')
  await expect
    .poll(() => existsSync(saved) && /"hibernated":\s*true/.test(readFileSync(saved, 'utf8')), {
      timeout: 15_000,
    })
    .toBe(true)
  await first.app.close()

  const { app, win } = await launch(first.dataHome)
  try {
    const restored = win.getByRole('tab').first()
    await expect(restored.getByLabel('Hibernated')).toBeVisible({ timeout: 15_000 })
    await restored.click()
    const frozen = frozenScreen(win)
    await expect(frozen.getByText('Asleep')).toBeVisible()
    await expect(frozen.locator('.xterm-rows')).toContainText(`${MARK} up`, { timeout: 15_000 })
  } finally {
    await app.close()
  }
})
