import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace, typeLineToEnd } from './helpers'
import { clickWith, hoverPoint, linkPoint } from './terminalLinks'
import { type ElectronApplication, _electron as electron, expect, test } from './test'

interface SystemCalls {
  opened: string[]
  shown: string[]
}

async function stubSystemOpeners(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ shell }) => {
    const calls = { opened: [] as string[], shown: [] as string[] }
    Object.assign(globalThis, { __systemCalls: calls })
    shell.openPath = async (path: string) => {
      calls.opened.push(path)
      return ''
    }
    shell.showItemInFolder = (path: string) => {
      calls.shown.push(path)
    }
  })
}

function systemCalls(app: ElectronApplication): Promise<SystemCalls> {
  return app.evaluate(() => (globalThis as unknown as { __systemCalls: SystemCalls }).__systemCalls)
}

test('the hover hint names every path link action, and the modifier clicks open with the default app, show in Files and show in the file manager', async () => {
  test.setTimeout(60_000)
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  mkdirSync(join(home, 'notes'), { recursive: true })
  writeFileSync(join(home, 'notes', 'report.xlsx'), 'sheet')
  const report = realpathSync(join(home, 'notes', 'report.xlsx'))

  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({ ...launch, env: { ...launch.env, HOME: home } })
  try {
    await stubSystemOpeners(app)
    const win = await app.firstWindow()
    await openWorkspace(win)
    await win.locator('.ghostty-host').first().click()
    await typeLineToEnd(win, "clear; printf 'wrote notes/report.xlsx\\n'")
    const target = await linkPoint(win, /^wrote notes\/report\.xlsx\s*$/, 'report')

    const hint = win.locator('[data-slot="tooltip-content"]')
    await hoverPoint(win, target)
    await expect(hint).toContainText('Ctrl+Click Open the file', { timeout: 5_000 })
    await expect(hint).toContainText('Ctrl+Shift+Click Open with its default app')
    await expect(hint).toContainText('Ctrl+Alt+Click Show in Files')
    await expect(hint).toContainText('Ctrl+Shift+Alt+Click Show in the file manager')

    await clickWith(win, target, ['Control', 'Shift'])
    await expect
      .poll(async () => (await systemCalls(app)).opened, { timeout: 10_000 })
      .toEqual([report])

    await clickWith(win, target, ['Control', 'Shift', 'Alt'])
    await expect
      .poll(async () => (await systemCalls(app)).shown, { timeout: 10_000 })
      .toEqual([report])

    await clickWith(win, target, ['Control', 'Alt'])
    await expect(
      win.locator('.file-tree').getByRole('button', { name: 'report.xlsx' }),
    ).toBeVisible({ timeout: 10_000 })
    await expect(win.locator('.monaco-editor')).toHaveCount(0)
    expect((await systemCalls(app)).opened).toEqual([report])
  } finally {
    await app.close()
  }
})
