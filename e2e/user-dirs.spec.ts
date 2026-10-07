import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { _electron as electron, expect, test } from './test'
import { freshDataHome, isolatedLaunch } from './dataHome'

function seedOldFolders(dataHome: string): string {
  const oldData = join(dataHome, 'pine')
  mkdirSync(oldData, { recursive: true })
  const snapshot = JSON.stringify({
    v: 1,
    savedAt: new Date().toISOString(),
    activeWorkspaceId: 's1',
    groups: [],
    workspaces: [
      {
        id: 's1',
        name: 'moved-over',
        kind: 'terminal',
        workDir: dataHome,
        root: { type: 'pane', id: 'pane-1', title: 'shell', kind: 'terminal', cwd: dataHome },
        activePaneId: 'pane-1',
      },
    ],
  })
  writeFileSync(join(oldData, 'workspaces.json'), snapshot)
  const oldViews = join(dataHome, 'config', 'pine', 'views')
  mkdirSync(oldViews, { recursive: true })
  writeFileSync(join(oldViews, 'kept.json'), '{}')
  mkdirSync(join(dataHome, '.pine', 'workflows'), { recursive: true })
  writeFileSync(join(dataHome, '.pine', 'workflows', 'build.yaml'), 'name: Build\ncommand: make\n')
  return snapshot
}

function launchAnswering(dataHome: string, answer: 'move' | 'later') {
  const options = isolatedLaunch(dataHome)
  return electron.launch({ ...options, env: { ...options.env, OSTIA_E2E_OLD_DIRS: answer } })
}

test('on the human’s confirm the old folders move to ostia, the old ones are deleted and the workspaces open', async () => {
  const dataHome = freshDataHome()
  seedOldFolders(dataHome)
  const app = await launchAnswering(dataHome, 'move')
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await expect(win.getByText('moved-over').first()).toBeVisible({ timeout: 15_000 })
    expect(existsSync(join(dataHome, 'config', 'ostia', 'views', 'kept.json'))).toBe(true)
    expect(existsSync(join(dataHome, '.ostia', 'workflows', 'build.yaml'))).toBe(true)
    expect(existsSync(join(dataHome, 'pine'))).toBe(false)
    expect(existsSync(join(dataHome, 'config', 'pine'))).toBe(false)
    expect(existsSync(join(dataHome, '.pine'))).toBe(false)
  } finally {
    await app.close()
  }
})

test('Not now leaves the old folders untouched and starts without them', async () => {
  const dataHome = freshDataHome()
  const snapshot = seedOldFolders(dataHome)
  const app = await launchAnswering(dataHome, 'later')
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await expect(win.getByText('moved-over')).toHaveCount(0)
    expect(readFileSync(join(dataHome, 'pine', 'workspaces.json'), 'utf8')).toBe(snapshot)
    expect(existsSync(join(dataHome, 'config', 'pine', 'views', 'kept.json'))).toBe(true)
  } finally {
    await app.close()
  }
})
