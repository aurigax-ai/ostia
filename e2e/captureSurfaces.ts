import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type CaptureSurface, sendToAgent } from './captureMatrix'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { launchWindow, openWorkspace, runInTerminal } from './helpers'
import { type ElectronApplication, _electron as electron, expect, type Page } from './test'
import { viewerGuestDrag, viewerGuestRun, viewerGuestText } from './viewerGuest'

const SOURCE = `export function total(items: number[]): number {
  return items.reduce((sum, item) => sum + item, 0)
}
`

const CSV = 'city,count\nTaipei,3\n"Hsinchu, East",4\nTainan,5\nKaohsiung,6\n'

const noHighlight = async (): Promise<void> => undefined

export const terminalSurface: CaptureSurface = {
  name: 'terminal',
  launch: async () => {
    const { app, win } = await launchWindow(freshDataHome())
    await openWorkspace(win)
    await runInTerminal(win, 'printf "\\n%.0s" 1 2 3 4 5 6 7 8 9; echo terminal-capture-4821')
    const output = win
      .locator('.terminal-text > div')
      .filter({ hasText: /^terminal-capture-4821$/ })
    await expect(output).toBeVisible({ timeout: 15_000 })
    const at = await output.boundingBox()
    if (!at) throw new Error('terminal output row has no box')
    await win.mouse.dblclick(at.x + 30, at.y + at.height / 2)
    return {
      app,
      win,
      open: () => win.keyboard.press(sendToAgent),
      chip: 'Copied',
      copied: /terminal-capture-4821/,
      cleared: noHighlight,
      close: () => app.close(),
    }
  },
}

export const monacoSurface: CaptureSurface = {
  name: 'monaco',
  launch: async () => {
    const dataHome = freshDataHome()
    const home = join(dataHome, 'home')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'total.ts'), SOURCE)
    const launch = isolatedLaunch(dataHome)
    const app = await electron.launch({ ...launch, env: { ...launch.env, HOME: home } })
    const win = await app.firstWindow()
    await openWorkspace(win)
    await win.locator('.topbar').getByRole('button', { name: 'Files', exact: true }).click()
    await win.locator('.file-row').filter({ hasText: 'total.ts' }).click()
    const editor = win.locator('.monaco-editor').first()
    await expect(editor).toContainText('items.reduce', { timeout: 15_000 })
    const lines = await editor.locator('.view-lines').first().boundingBox()
    if (!lines) throw new Error('editor lines have no box')
    const y = lines.y + 27
    await win.mouse.move(lines.x + 8, y)
    await win.mouse.down()
    await win.mouse.move(lines.x + 240, y, { steps: 5 })
    await win.mouse.up()
    return {
      app,
      win,
      open: () => win.keyboard.press(sendToAgent),
      chip: 'Copied',
      copied: /items\.reduce|return|function/,
      cleared: noHighlight,
      close: () => app.close(),
    }
  },
}

const TABLE = { viewType: 'csv.table', name: 'orders.csv' }

async function cellBox(app: ElectronApplication, row: number, column: number) {
  return (await viewerGuestRun(
    app,
    TABLE,
    `(() => { const r = document.querySelector('[data-part="cell"][data-row="${row}"][data-column="${column}"]').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`,
  )) as { x: number; y: number }
}

async function openCsvTable(win: Page): Promise<void> {
  await win.locator('.file-row').filter({ hasText: 'orders.csv' }).click()
  for (const dismiss of await win
    .locator('output')
    .getByRole('button', { name: 'Dismiss' })
    .all()) {
    await dismiss.click()
  }
  await win.locator('.pane-tab:visible').last().click({ button: 'right' })
  await win.getByRole('menuitem', { name: 'Open With…' }).click()
  await win.getByRole('radio', { name: 'Table' }).click()
  await win.getByRole('button', { name: 'Open', exact: true }).click()
  await expect(win.locator('[data-testid="file-viewer"]:visible')).toHaveAttribute(
    'data-view-type',
    'csv.table',
    { timeout: 15_000 },
  )
}

export const csvViewerSurface: CaptureSurface = {
  name: 'viewer-csv',
  launch: async () => {
    const dataHome = freshDataHome()
    const home = join(dataHome, 'home')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'orders.csv'), CSV)
    const launch = isolatedLaunch(dataHome)
    const app = await electron.launch({ ...launch, env: { ...launch.env, HOME: home } })
    const win = await app.firstWindow()
    await openWorkspace(win)
    await win.locator('.topbar').getByRole('button', { name: 'Files', exact: true }).click()
    await openCsvTable(win)
    await expect.poll(() => viewerGuestText(app, TABLE), { timeout: 20_000 }).toContain('Hsinchu')
    return {
      app,
      win,
      open: async () => {
        await viewerGuestDrag(app, TABLE, await cellBox(app, 0, 0), await cellBox(app, 2, 1))
      },
      chip: 'Copied table',
      copied: /Taipei/,
      cleared: async () => {
        await expect
          .poll(
            () =>
              viewerGuestRun(
                app,
                TABLE,
                'document.querySelectorAll(".ostia-grid-selected").length',
              ),
            { timeout: 5_000 },
          )
          .toBe(0)
      },
      file: {
        append: async (rows, everyMs) => {
          for (let row = 0; row < rows; row++) {
            appendFileSync(join(home, 'orders.csv'), `Row${row},${row}\n`)
            await new Promise((resolve) => setTimeout(resolve, everyMs))
          }
        },
        editMiddleRow: () =>
          writeFileSync(join(home, 'orders.csv'), CSV.replace('Tainan', 'Hualien')),
      },
      close: () => app.close(),
    }
  },
}
