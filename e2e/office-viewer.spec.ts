import { mkdirSync, writeFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import {
  externalLinkWorkbook,
  macroWorkbook,
  workbook,
  zeroBomb,
} from '../test/fixtures/office/workbooks'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'
import { type Page, _electron as electron, expect, test } from './test'

const MIB = 1024 * 1024

async function withApp(
  files: Record<string, Uint8Array>,
  run: (win: Page) => Promise<void>,
): Promise<void> {
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  mkdirSync(home, { recursive: true })
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(home, name), bytes)
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({ ...launch, env: { ...launch.env, HOME: home } })
  try {
    const win = await app.firstWindow()
    await openWorkspace(win)
    await win.locator('.topbar').getByRole('button', { name: 'Files', exact: true }).click()
    await run(win)
  } finally {
    await app.close()
  }
}

async function openFile(win: Page, name: string): Promise<void> {
  await win.locator('.file-row').filter({ hasText: name }).click()
}

function visibleViewer(win: Page) {
  return win.locator('[data-testid="sheet-viewer"]:visible')
}

test('an xlsx file opens as a grid with its sheets as tabs', async () => {
  const report = workbook(
    {
      Sales: [
        ['region', 'total'],
        ['North', 1234567.5],
      ],
      Notes: [['checked by', 'Lee']],
    },
    'xlsx',
    (book) => {
      book.Sheets.Sales.C2 = { t: 'n', v: 0.125, z: '0.00%' }
      book.Sheets.Sales['!ref'] = 'A1:C2'
    },
  )
  await withApp({ 'report.xlsx': report }, async (win) => {
    await openFile(win, 'report.xlsx')
    const viewer = visibleViewer(win)
    const grid = viewer.getByTestId('sheet-grid')
    await expect(grid.getByRole('cell', { name: 'North' })).toBeVisible({ timeout: 15_000 })
    await expect(grid.getByRole('cell', { name: '1234567.5' })).toBeVisible()
    await expect(grid.getByRole('cell', { name: '12.50%' })).toBeVisible()
    await expect(grid.getByRole('columnheader')).toHaveText(['A', 'B', 'C'])
    await expect(viewer.locator('.monaco-editor')).toHaveCount(0)

    await viewer.getByRole('tab', { name: 'Notes' }).click()
    await expect(viewer.getByTestId('sheet-grid').getByRole('cell', { name: 'Lee' })).toBeVisible()
  })
})

test('a macro workbook and a workbook with external links open without running or fetching anything', async () => {
  const requests: string[] = []
  const server: Server = createServer((req, res) => {
    requests.push(req.url ?? '')
    res.end('nothing')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    await withApp(
      { 'macros.xlsm': macroWorkbook(), 'links.xlsx': externalLinkWorkbook(url) },
      async (win) => {
        await openFile(win, 'macros.xlsm')
        await expect(visibleViewer(win).getByRole('cell', { name: 'macro book' })).toBeVisible({
          timeout: 15_000,
        })

        await openFile(win, 'links.xlsx')
        const links = visibleViewer(win)
        await expect(links.getByRole('cell', { name: 'open me' })).toBeVisible({ timeout: 15_000 })
        await expect(links.locator('a')).toHaveCount(0)
      },
    )
    expect(requests).toEqual([])
  } finally {
    server.close()
  }
})

test('a malformed file, a zip bomb and a long sheet each say why', async () => {
  const long = workbook({
    Long: Array.from({ length: 100_500 }, (_unused, row) => [row + 1]),
  })
  await withApp(
    {
      'broken.xlsx': new TextEncoder().encode('this is not a workbook'),
      'bomb.xlsx': zeroBomb(129 * MIB),
      'long.xlsx': long,
    },
    async (win) => {
      await openFile(win, 'broken.xlsx')
      await expect(visibleViewer(win)).toContainText('Could not read this file.', {
        timeout: 15_000,
      })

      await openFile(win, 'bomb.xlsx')
      await expect(visibleViewer(win)).toContainText('so it is not previewed', {
        timeout: 15_000,
      })
      await expect(win.locator('.topbar')).toBeVisible()

      await openFile(win, 'long.xlsx')
      const viewer = visibleViewer(win)
      const grid = viewer.getByTestId('sheet-grid')
      await expect(viewer.getByTestId('sheet-grid-note')).toHaveText(
        'Showing the first 100,000 rows.',
        { timeout: 30_000 },
      )
      expect(await grid.locator('tbody tr').count()).toBeLessThan(200)
      await grid.evaluate((element) => {
        element.scrollTop = element.scrollHeight
      })
      await expect(grid.getByRole('rowheader', { name: '100000', exact: true })).toBeVisible()
      await expect(grid.getByRole('cell', { name: '100000', exact: true })).toBeVisible()
    },
  )
})
