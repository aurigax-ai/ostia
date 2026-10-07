import {
  type ElectronApplication,
  type Page,
  _electron as electron,
  expect,
  test,
} from './test'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'

async function launch(dataHome: string): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch(isolatedLaunch(dataHome))
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  return { app, win }
}

async function quit(app: ElectronApplication): Promise<void> {
  await app
    .evaluate(({ app: electronApp }) => {
      setTimeout(() => electronApp.quit(), 0)
    })
    .catch(() => {})
  await app.close().catch(() => {})
}

async function run(win: Page, line: string): Promise<void> {
  await win.keyboard.type(line)
  await win.keyboard.press('Enter')
}

const coordinatorRows = (win: Page) => win.locator('.xterm-rows').first()
const memberRows = (win: Page) => win.locator('.rail-group-members .rail-row')

test('a coordinator makes a background workers workspace in its sidebar group and dispatches a worker there', async () => {
  test.setTimeout(90_000)
  const { app, win } = await launch(freshDataHome())
  try {
    await openWorkspace(win)
    await win.locator('.xterm').first().click()

    await run(
      win,
      `ostia workspace group proj && ostia workspace.new '{"name":"proj · workers","focus":false,"group":"proj"}'`,
    )
    await expect(coordinatorRows(win)).toContainText('"workspaceId"', { timeout: 15_000 })
    await expect(memberRows(win)).toHaveCount(2)
    await expect(memberRows(win).nth(1)).toContainText('proj · workers')
    await expect(win.locator('.rail-tab.active')).toHaveCount(1)
    await expect(win.locator('.rail-tab.active')).not.toContainText('proj · workers')

    await run(
      win,
      `ostia process run "echo hi-from-$((40+2)); sleep 30" --name fixer --workspace "proj · workers"`,
    )
    const card = win.getByRole('region', { name: 'Agent permission request' })
    await expect(card).toBeVisible({ timeout: 20_000 })
    await card.getByRole('button', { name: 'Allow once' }).click()
    await expect(coordinatorRows(win)).toContainText('"name":"fixer"', { timeout: 20_000 })
    await expect(win.getByRole('tablist').getByRole('tab')).toHaveCount(1)
    await expect(win.locator('.rail-tab.active')).not.toContainText('proj · workers')

    await memberRows(win).nth(1).locator('.rail-tab-main').click()
    await expect(win.locator('.rail-tab.active')).toContainText('proj · workers')
    await expect(win.getByRole('tab', { name: /fixer/ })).toBeVisible({ timeout: 15_000 })
    await expect(win.locator('.xterm-rows').last()).toContainText('hi-from-42', { timeout: 15_000 })
  } finally {
    await quit(app)
  }
})
