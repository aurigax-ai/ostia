import { mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import {
  CANVAS_RENDERER_SETTINGS,
  freshDataHome,
  HIBERNATE_FAST,
  isolatedLaunch,
  seedSettings,
} from './dataHome'
import { fakeAgentBin } from './fakeAgent'
import { expectHeld, openWorkspace, PROMPT, runInTerminal, shownTerminal } from './helpers'
import { _electron as electron, expect, test } from './test'

test.describe.configure({ timeout: 90_000 })

async function hibernatedAgentIn(
  tree: string,
  token: string,
  start: (home: string) => string[],
  shell?: string,
) {
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  mkdirSync(tree, { recursive: true })
  mkdirSync(home, { recursive: true })
  const payload = JSON.stringify({ session_id: token, cwd: home })
  const bin = fakeAgentBin(
    dataHome,
    [
      '#!/bin/sh',
      'case "$*" in',
      '  *--resume*) ;;',
      `  *) echo '${payload}' | ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" "$OSTIA_CLI" resume-token claude - >/dev/null 2>&1 ;;`,
      'esac',
      'echo "fake agent up: $* in $(pwd)"',
      'exec sleep 600',
      '',
    ].join('\n'),
  )
  seedSettings(dataHome, {
    ...CANVAS_RENDERER_SETTINGS,
    agents: { hibernation: HIBERNATE_FAST },
  })
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...launch,
    env: {
      ...launch.env,
      HOME: home,
      PATH: `${bin}:${launch.env.PATH ?? ''}`,
      ...(shell ? { SHELL: shell } : {}),
    },
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await openWorkspace(win)
  for (const line of start(home)) await runInTerminal(win, line, shownTerminal(win))
  await expect(win.locator('.terminal-text').first()).toContainText('fake agent up:', {
    timeout: 15_000,
  })
  await win.getByRole('button', { name: 'New terminal tab' }).click()
  await expect(win.getByRole('tab')).toHaveCount(2)
  await expect(win.locator('.pane-slot:not([data-hidden]) .terminal-text')).toContainText(PROMPT, {
    timeout: 15_000,
  })
  const sleeping = win.getByRole('tab').first()
  await expect(sleeping.getByLabel('Hibernated')).toBeVisible({ timeout: 30_000 })
  return { app, win, home, sleeping }
}

test('waking an agent whose folder was removed shows a notice and runs nothing', async () => {
  const root = freshDataHome()
  const tree = join(root, 'work', 'tree')
  const { app, win, sleeping } = await hibernatedAgentIn(tree, 'e2e-tok-gone', () => [
    `cd '${tree}'`,
    'claude',
  ])
  try {
    renameSync(tree, join(root, 'work', 'tree-moved'))
    await sleeping.click()
    await win.locator('.hibernated-view').click()
    const notice = win.getByRole('region', { name: 'Agent folder missing' })
    await expect(notice).toBeVisible({ timeout: 20_000 })
    const rows = win.locator('.pane-slot:not([data-hidden]) .terminal-text')
    await expect(rows).toContainText(PROMPT, { timeout: 15_000 })
    await expectHeld(async () => (await rows.innerText()).includes('--resume e2e-tok-gone'), false)
  } finally {
    await app.close()
  }
})

test('an agent started with a cd on the same line resumes in the folder it ran in, also in bash, which reports the folder only at its prompt', async () => {
  const root = freshDataHome()
  const tree = join(root, 'work', 'tree')
  const { app, win, sleeping } = await hibernatedAgentIn(
    tree,
    'e2e-tok-cd',
    (home) => [`cd '${home}' && echo at-$((6*7))`, `cd '${tree}' && claude`],
    '/bin/bash',
  )
  try {
    await sleeping.click()
    await win.locator('.hibernated-view').click()
    await expect(win.locator('.pane-slot:not([data-hidden]) .terminal-text')).toContainText(
      `--resume e2e-tok-cd in ${tree}`,
      { timeout: 20_000 },
    )
  } finally {
    await app.close()
  }
})
