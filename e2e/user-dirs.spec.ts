import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { _electron as electron, expect, test } from './test'

function seedOldFolders(dataHome: string): void {
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
  mkdirSync(join(dataHome, '.pine', 'snippets'), { recursive: true })
  writeFileSync(join(dataHome, '.pine', 'snippets', 'build.yaml'), 'name: Build\ncommand: make\n')
}

test('on the human’s confirm the old folders move to ostia and the workspaces open', async () => {
  const dataHome = freshDataHome()
  seedOldFolders(dataHome)
  const options = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...options,
    env: { ...options.env, OSTIA_E2E_OLD_DIRS: 'move' },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await expect(win.getByText('moved-over').first()).toBeVisible({ timeout: 15_000 })
    expect(existsSync(join(dataHome, '.ostia', 'snippets', 'build.yaml'))).toBe(true)
  } finally {
    await app.close()
  }
})
