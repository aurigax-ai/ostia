import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { freshDataHome } from './dataHome'
import {
  PROMPT,
  emptyState,
  emptyWorkspace,
  launchWindow,
  quitApp,
  runInTerminal,
  shownTerminal,
} from './helpers'
import { type Page, expect, test } from './test'

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

async function printValue(win: Page, label: string, variable: string): Promise<string> {
  await runInTerminal(win, `echo "${label}:""$${variable}"":END"`, shownTerminal(win))
  const rows = win.locator('.xterm:visible .xterm-rows').first()
  const pattern = new RegExp(`${label}:(/[^"]*?):END`)
  await expect(rows).toContainText(pattern, { timeout: 15_000 })
  const match = pattern.exec((await rows.textContent()) ?? '')
  if (!match) throw new Error(`${label} was not printed`)
  return match[1]
}

test('a scratch workspace runs in its private folder, deletes it on close, and never comes back', async () => {
  test.setTimeout(90_000)
  const dataHome = freshDataHome()
  let folder = ''
  let leftOpen = ''

  const first = await launchWindow(dataHome)
  try {
    const { win } = first
    await expect(emptyState(win)).toBeVisible({ timeout: 15_000 })
    await newScratchWorkspace(win)
    const row = scratchRow(win, 'Scratch')
    await expect(row).toBeVisible()

    await emptyWorkspace(win).getByRole('button', { name: 'New terminal' }).click()
    await expect(win.locator('.xterm-rows').first()).toContainText(PROMPT, { timeout: 15_000 })

    folder = await printValue(win, 'DIR', 'PWD')
    expect(dirname(folder)).toMatch(/ostia-scratch-\d+$/)

    await runInTerminal(win, 'echo hi > a.txt', shownTerminal(win))
    await expect.poll(() => existsSync(join(folder, 'a.txt'))).toBe(true)

    await row.hover()
    await row.getByRole('button', { name: 'Close', exact: true }).click()
    await win.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()
    await expect(row).toHaveCount(0)
    await expect.poll(() => existsSync(folder), { timeout: 10_000 }).toBe(false)

    await newScratchWorkspace(win)
    const second = scratchRow(win, 'Scratch')
    await expect(second).toBeVisible()
    await emptyWorkspace(win).getByRole('button', { name: 'New terminal' }).click()
    await expect(win.locator('.xterm-rows').first()).toContainText(PROMPT, { timeout: 15_000 })
    leftOpen = await printValue(win, 'DIR2', 'PWD')
    expect(existsSync(leftOpen)).toBe(true)
  } finally {
    await quitApp(first.app)
  }

  expect(existsSync(leftOpen)).toBe(false)

  const second = await launchWindow(dataHome)
  try {
    await expect(emptyState(second.win)).toBeVisible({ timeout: 15_000 })
    await expect(second.win.locator('.rail-tab')).toHaveCount(0)
  } finally {
    await quitApp(second.app)
  }
})
