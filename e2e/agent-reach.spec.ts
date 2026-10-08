import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { fakeAgentBin, isolatedHome } from './fakeAgent'
import { PROMPT, emptyWorkspace, openWorkspace, typeLine } from './helpers'
import { _electron as electron, expect, test } from './test'

function repoWithWorktree(home: string): { main: string; worktree: string; other: string } {
  const main = join(home, 'proj')
  const worktree = join(home, 'proj-workers')
  const gitDir = join(main, '.git', 'worktrees', 'proj-workers')
  mkdirSync(gitDir, { recursive: true })
  mkdirSync(worktree, { recursive: true })
  writeFileSync(join(gitDir, 'commondir'), '../..\n')
  writeFileSync(join(worktree, '.git'), `gitdir: ${gitDir}\n`)
  const other = join(home, 'other')
  mkdirSync(join(other, '.git'), { recursive: true })
  return { main, worktree, other }
}

test('an agent starts a worker in a workspace of its own project without asking, and asks for another project or one it moved its folder into', async () => {
  test.setTimeout(90_000)
  const dataHome = freshDataHome()
  const bin = fakeAgentBin(dataHome)
  const home = isolatedHome(dataHome)
  const dirs = repoWithWorktree(home)
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...launch,
    env: { ...launch.env, HOME: home, PATH: `${bin}:${launch.env.PATH ?? ''}` },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await win.locator('.xterm').first().click()
    await typeLine(win, `ostia workspace.new '${JSON.stringify({ dir: dirs.main, name: 'proj' })}'`)
    await emptyWorkspace(win).getByRole('button', { name: 'New terminal' }).click()
    const coordinator = win.locator('.xterm-rows:visible').first()
    await expect(coordinator).toContainText(PROMPT, { timeout: 15_000 })
    await win.locator('.xterm:visible').first().click()

    const workers = { dir: dirs.worktree, name: 'proj workers', focus: false }
    await typeLine(win, `ostia workspace.new '${JSON.stringify(workers)}'`)
    await typeLine(
      win,
      'ostia agent run claude "fix the login bug" --name fixer --workspace "proj workers"; echo run-exit-$?',
    )
    await expect(coordinator).toContainText('run-exit-0', { timeout: 15_000 })
    await expect(coordinator).toContainText('"name":"fixer"')
    await expect(win.getByRole('region', { name: 'Agent permission request' })).toHaveCount(0)

    await typeLine(win, 'ostia process ls')
    await expect(coordinator).toContainText(/fixer\s+running/, { timeout: 15_000 })

    const other = { dir: dirs.other, name: 'other', focus: false }
    await typeLine(win, `ostia workspace.new '${JSON.stringify(other)}'`)
    await typeLine(
      win,
      'ostia agent run claude "look around" --name stranger --workspace other; echo other-exit-$?',
    )
    const card = win.getByRole('region', { name: 'Agent permission request' })
    await expect(card).toBeVisible({ timeout: 15_000 })
    await expect(card).toContainText('act on other panes and workspaces')
    await card.getByRole('button', { name: 'Deny' }).click()
    await expect(coordinator).toContainText('denied: all-workspaces', { timeout: 15_000 })
    await expect(coordinator).toContainText('other-exit-1')

    await win.locator('.xterm:visible').first().click()
    await typeLine(win, `ostia workspace dir ${dirs.other}; echo dir-exit-$?`)
    await expect(coordinator).toContainText('dir-exit-0', { timeout: 15_000 })
    await typeLine(
      win,
      'ostia agent run claude "look again" --name drifter --workspace other; echo drift-exit-$?',
    )
    await expect(card).toBeVisible({ timeout: 15_000 })
    await expect(card).toContainText(`An agent set a workspace’s folder to ${dirs.other}`)
    await card.getByRole('button', { name: 'Deny' }).click()
    await expect(card).toContainText('act on other panes and workspaces', { timeout: 15_000 })
    await card.getByRole('button', { name: 'Deny' }).click()
    await expect(coordinator).toContainText('drift-exit-1', { timeout: 15_000 })
  } finally {
    await app.close()
  }
})
