import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { openWorkspace, typeLineToEnd } from './helpers'
import { type Point, clickWith, hoverPoint, linkPoint, printOnFirstRow } from './terminalLinks'
import { _electron as electron, expect, test } from './test'

test('Ctrl+click on a file path in terminal output opens it in the editor at that line', async () => {
  test.setTimeout(60_000)
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  mkdirSync(join(home, 'notes'), { recursive: true })
  const source = Array.from({ length: 40 }, (_, i) => `const line${i + 1} = ${i + 1}`).join('\n')
  writeFileSync(join(home, 'notes', 'app.ts'), `${source}\n`)

  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({ ...launch, env: { ...launch.env, HOME: home } })
  try {
    const win = await app.firstWindow()
    await openWorkspace(win)
    await win.locator('.xterm').first().click()
    await typeLineToEnd(win, "clear; printf 'error at notes/app.ts:27:7\\n'")
    const target = await linkPoint(win, /^error at notes\/app\.ts:27:7\s*$/, 'app.ts')
    await clickWith(win, target, ['Control'])

    await expect(win.locator('.monaco-editor').first()).toBeVisible({ timeout: 15_000 })
    await expect(win.locator('.pane-header .title').filter({ hasText: 'app.ts' })).toBeVisible()
    await expect(win.locator('.monaco-editor .active-line-number').first()).toHaveText('27', {
      timeout: 10_000,
    })
  } finally {
    await app.close()
  }
})

const ENGINES = [
  { name: 'xterm', screen: '.xterm-screen', settings: DOM_RENDERER_SETTINGS },
  {
    name: 'Ghostty',
    screen: '.ghostty-screen',
    settings: { ...DOM_RENDERER_SETTINGS, terminal: { renderer: 'ghostty' } },
  },
]

for (const engine of ENGINES) {
  test(`${engine.name}: Ctrl+click reveals a folder in Files, opens an outside folder in the file manager and opens an outside file`, async () => {
    test.setTimeout(120_000)
    const dataHome = freshDataHome()
    seedSettings(dataHome, engine.settings)
    const launch = isolatedLaunch(dataHome)
    mkdirSync(join(launch.home, 'notes', 'sub'), { recursive: true })
    writeFileSync(join(launch.home, 'notes', 'sub', 'inner.txt'), 'inside\n')
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-e2e-outside-')))
    mkdirSync(join(outside, 'shots'))
    const outsideFile = join(outside, 'shots', 'report.txt')
    writeFileSync(outsideFile, Array.from({ length: 12 }, (_, i) => `row ${i + 1}`).join('\n'))

    const app = await electron.launch({ ...launch, env: { ...launch.env, SHELL: '/bin/zsh' } })
    try {
      const win = await app.firstWindow()
      await app.evaluate(({ shell }) => {
        const opened: string[] = []
        Object.assign(globalThis, { __openedPaths: opened })
        shell.openPath = async (path: string) => {
          opened.push(path)
          return ''
        }
      })
      await openWorkspace(win)
      const screen = win.locator(`.pane-slot:not([data-hidden]) ${engine.screen}`).first()

      const hoverLink = async (text: string): Promise<Point> => {
        const target = await printOnFirstRow(win, screen, text)
        await hoverPoint(win, target)
        return target
      }
      const ctrlClick = (target: Point) => clickWith(win, target, ['Control'])
      const hint = win.locator('[data-slot="tooltip-content"]')
      const openedPaths = (): Promise<string[]> =>
        app.evaluate(() => (globalThis as unknown as { __openedPaths: string[] }).__openedPaths)

      const inside = await hoverLink('notes/sub')
      await expect(hint).toContainText('Ctrl+Click Show the folder in Files', { timeout: 5_000 })
      await ctrlClick(inside)
      await expect(win.locator('.file-tree').getByText('inner.txt')).toBeVisible({
        timeout: 15_000,
      })
      expect(await openedPaths()).toEqual([])

      const folder = await hoverLink(`${outside}/shots/`)
      await expect(hint).toContainText('Ctrl+Click Open the folder in the file manager', {
        timeout: 5_000,
      })
      await win.mouse.click(folder.x, folder.y)
      await ctrlClick(folder)
      await expect.poll(openedPaths, { timeout: 15_000 }).toEqual([join(outside, 'shots')])

      const file = await hoverLink(`${outsideFile}:7`)
      await expect(hint).toContainText('Ctrl+Click Open the file', { timeout: 5_000 })
      await ctrlClick(file)
      await expect(win.locator('.monaco-editor').first()).toBeVisible({ timeout: 15_000 })
      await expect(
        win.locator('.pane-header .title').filter({ hasText: 'report.txt' }),
      ).toBeVisible()
      await expect(win.locator('.monaco-editor .active-line-number').first()).toHaveText('7', {
        timeout: 10_000,
      })
      expect(await openedPaths()).toEqual([join(outside, 'shots')])
    } finally {
      await app.close()
      rmSync(outside, { recursive: true, force: true })
    }
  })
}
