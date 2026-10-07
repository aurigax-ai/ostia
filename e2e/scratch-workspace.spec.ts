import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  type ElectronApplication,
  type Page,
  _electron as electron,
  expect,
  test,
} from './test'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { PROMPT, emptyState, emptyWorkspace } from './helpers'

async function launchApp(dataHome: string): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch(isolatedLaunch(dataHome))
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    return { app, win }
  } catch (err) {
    await app.close()
    throw err
  }
}

async function quitApp(app: ElectronApplication): Promise<void> {
  await app
    .evaluate(({ app: electronApp }) => {
      setTimeout(() => electronApp.quit(), 0)
    })
    .catch(() => {})
  await app.close().catch(() => {})
}

async function newScratchWorkspace(win: Page): Promise<void> {
  await win
    .locator('.topbar')
    .getByRole('button', { name: 'More ways to start a workspace' })
    .click()
  await win.getByRole('menuitem', { name: 'New scratch workspace' }).click()
}

function scratchRow(win: Page, name: string) {
  return win.locator('.rail-tab', { has: win.getByText(name, { exact: true }) })
}

async function run(win: Page, command: string): Promise<void> {
  await win.locator('.xterm:visible').first().click()
  await win.keyboard.type(command)
  await win.keyboard.press('Enter')
}

async function printValue(win: Page, label: string, variable: string): Promise<string> {
  await run(win, `echo "${label}:""$${variable}"":END"`)
  const rows = win.locator('.xterm:visible .xterm-rows').first()
  const pattern = new RegExp(`${label}:(/[^"]*?):END`)
  await expect(rows).toContainText(pattern, { timeout: 15_000 })
  const match = pattern.exec((await rows.textContent()) ?? '')
  if (!match) throw new Error(`${label} was not printed`)
  return match[1]
}

test('a scratch workspace keeps history in its private folder, deletes it on close, and never comes back', async () => {
  test.setTimeout(90_000)
  const dataHome = freshDataHome()
  const marker = `ostia_scratch_${Date.now()}`
  let folder = ''
  let leftOpen = ''

  const first = await launchApp(dataHome)
  try {
    const { win } = first
    await expect(emptyState(win)).toBeVisible({ timeout: 15_000 })
    await newScratchWorkspace(win)
    const row = scratchRow(win, 'Scratch')
    await expect(row).toBeVisible()
    await expect(row.locator('.scratch-badge')).toHaveText('Scratch')

    await emptyWorkspace(win).getByRole('button', { name: 'New terminal' }).click()
    await expect(win.locator('.xterm-rows').first()).toContainText(PROMPT, { timeout: 15_000 })

    folder = await printValue(win, 'DIR', 'PWD')
    expect(dirname(folder)).toMatch(/ostia-scratch-\d+$/)

    expect(await printValue(win, 'HF', 'HISTFILE')).toBe(join(folder, '.ostia_history'))

    await run(win, 'echo hi > a.txt')
    await run(win, `echo ${marker}`)
    await expect(win.locator('.xterm:visible .xterm-rows').first()).toContainText(marker, {
      timeout: 15_000,
    })
    await expect.poll(() => existsSync(join(folder, 'a.txt'))).toBe(true)

    await expect
      .poll(() => existsSync(join(dataHome, 'ostia', 'scrollback.json')), { timeout: 15_000 })
      .toBe(true)
    await win.waitForTimeout(6_000)
    expect(readFileSync(join(dataHome, 'ostia', 'scrollback.json'), 'utf8')).not.toContain(marker)

    await row.hover()
    await row.getByRole('button', { name: 'Close', exact: true }).click()
    const dialog = win.getByRole('dialog')
    await expect(dialog).toContainText('Delete 1 file in the scratch folder?')
    await dialog.getByRole('button', { name: 'Delete' }).click()
    await expect(row).toHaveCount(0)
    await expect.poll(() => existsSync(folder), { timeout: 10_000 }).toBe(false)

    await newScratchWorkspace(win)
    const second = scratchRow(win, 'Scratch')
    await expect(second).toBeVisible()
    await emptyWorkspace(win).getByRole('button', { name: 'New terminal' }).click()
    await expect(win.locator('.xterm-rows').first()).toContainText(PROMPT, { timeout: 15_000 })
    leftOpen = await printValue(win, 'DIR2', 'PWD')
    expect(existsSync(leftOpen)).toBe(true)
    await win.waitForTimeout(1_000)
    const saved = readFileSync(join(dataHome, 'ostia', 'workspaces.json'), 'utf8')
    expect(saved).not.toContain(leftOpen)
  } finally {
    await quitApp(first.app)
  }

  expect(existsSync(leftOpen)).toBe(false)

  const second = await launchApp(dataHome)
  try {
    await expect(emptyState(second.win)).toBeVisible({ timeout: 15_000 })
    await expect(second.win.locator('.rail-tab')).toHaveCount(0)
  } finally {
    await quitApp(second.app)
  }
})
