import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { freshDataHome, isolatedLaunch } from './dataHome'

function seedLegacy(dataHome: string): string {
  const legacyData = join(dataHome, 'pine')
  mkdirSync(legacyData, { recursive: true })
  const snapshot = JSON.stringify({
    v: 1,
    savedAt: new Date().toISOString(),
    activeWorkspaceId: 's1',
    groups: [],
    workspaces: [
      {
        id: 's1',
        name: 'from-pine',
        kind: 'terminal',
        workDir: dataHome,
        root: { type: 'pane', id: 'pane-1', title: 'shell', kind: 'terminal', cwd: dataHome },
        activePaneId: 'pane-1',
      },
    ],
  })
  writeFileSync(join(legacyData, 'workspaces.json'), snapshot)
  const legacyViews = join(dataHome, 'config', 'pine', 'views')
  mkdirSync(legacyViews, { recursive: true })
  writeFileSync(join(legacyViews, 'kept.json'), '{}')
  return snapshot
}

test('a first launch copies the old pine folders to ostia and opens the old workspaces', async () => {
  const dataHome = freshDataHome()
  const snapshot = seedLegacy(dataHome)
  const app = await electron.launch(isolatedLaunch(dataHome))
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await expect(win.getByText('from-pine').first()).toBeVisible({ timeout: 15_000 })
    expect(existsSync(join(dataHome, 'ostia', 'workspaces.json'))).toBe(true)
    expect(existsSync(join(dataHome, 'config', 'ostia', 'views', 'kept.json'))).toBe(true)
    expect(existsSync(join(dataHome, 'pine', 'MOVED-TO-OSTIA.txt'))).toBe(true)
    expect(existsSync(join(dataHome, 'config', 'pine', 'MOVED-TO-OSTIA.txt'))).toBe(true)
    expect(readFileSync(join(dataHome, 'pine', 'workspaces.json'), 'utf8')).toBe(snapshot)
  } finally {
    await app.close()
  }
})
