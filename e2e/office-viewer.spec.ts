import { mkdirSync, writeFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import {
  docx,
  externalLinkWorkbook,
  externalRelationship,
  hiddenDirectoryBomb,
  hyperlinkRange,
  macroWorkbook,
  odsRepeats,
  paragraph,
  picture,
  workbook,
  zeroBomb,
} from '../test/fixtures/office/workbooks'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'
import { type ElectronApplication, type Page, _electron as electron, expect, test } from './test'
import { viewerGuestRun, viewerGuestText } from './viewerGuest'

const MIB = 1024 * 1024
const SHEET = 'office.spreadsheet'

async function withApp(
  files: Record<string, Uint8Array>,
  run: (win: Page, app: ElectronApplication) => Promise<void>,
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
    await run(win, app)
  } finally {
    await app.close()
  }
}

async function openSheet(win: Page, name: string): Promise<void> {
  await win.locator('.file-row').filter({ hasText: name }).click()
  await expect(win.locator('[data-testid="file-viewer"]:visible')).toHaveAttribute(
    'data-view-type',
    SHEET,
    { timeout: 15_000 },
  )
}

function guestText(app: ElectronApplication, name: string) {
  return expect.poll(() => viewerGuestText(app, { viewType: SHEET, name }), { timeout: 20_000 })
}

test('an xlsx file opens in the spreadsheet viewer with its sheets as tabs', async () => {
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
  await withApp({ 'report.xlsx': report }, async (win, app) => {
    await openSheet(win, 'report.xlsx')
    await guestText(app, 'report.xlsx').toContain('North')
    const shown = await viewerGuestText(app, { viewType: SHEET, name: 'report.xlsx' })
    expect(shown).toContain('1234567.5')
    expect(shown).toContain('12.50%')
    expect(await win.locator('.monaco-editor:visible').count()).toBe(0)
    await viewerGuestRun(
      app,
      { viewType: SHEET, name: 'report.xlsx' },
      '[...document.querySelectorAll("[role=tab]")].find((b) => b.textContent === "Notes").click()',
    )
    await guestText(app, 'report.xlsx').toContain('Lee')
  })
})

test('a macro workbook, and a workbook and a document with external links, open without running or fetching anything', async () => {
  const requests: string[] = []
  const server: Server = createServer((req, res) => {
    requests.push(req.url ?? '')
    res.end('nothing')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    await withApp(
      {
        'macros.xlsm': macroWorkbook(),
        'links.xlsx': externalLinkWorkbook(url),
        'notes.docx': docx({
          body:
            paragraph('Quarterly notes') +
            paragraph('&lt;img src=x onerror=alert(1)&gt;') +
            picture('r:embed', 'rPng', 'inside') +
            picture('r:link', 'rFar', 'outside') +
            '<w:p><w:hyperlink r:id="rSite"><w:r><w:t>site</w:t></w:r></w:hyperlink></w:p>',
          relationships:
            externalRelationship('rFar', 'image', `${url}/far.png`) +
            externalRelationship('rSite', 'hyperlink', `${url}/page`),
        }),
      },
      async (win, app) => {
        await openSheet(win, 'macros.xlsm')
        await guestText(app, 'macros.xlsm').toContain('macro book')
        await openSheet(win, 'links.xlsx')
        await guestText(app, 'links.xlsx').toContain('open me')
        expect(
          await viewerGuestRun(
            app,
            { viewType: SHEET, name: 'links.xlsx' },
            'document.querySelectorAll("a").length',
          ),
        ).toBe(0)
        const fetched = await viewerGuestRun(
          app,
          { viewType: SHEET, name: 'links.xlsx' },
          `fetch(${JSON.stringify(`${url}/probe`)}).then(() => 'reached', () => 'blocked')`,
        )
        expect(fetched).toBe('blocked')

        await win.locator('.file-row').filter({ hasText: 'notes.docx' }).click()
        const doc = { viewType: 'office.document', name: 'notes.docx' }
        await expect
          .poll(() => viewerGuestText(app, doc), { timeout: 20_000 })
          .toContain('Quarterly notes')
        expect(await viewerGuestText(app, doc)).toContain('<img src=x onerror=alert(1)>')
        expect(
          await viewerGuestRun(
            app,
            doc,
            'JSON.stringify([document.querySelectorAll("a[href]").length, [...document.images].map((i) => i.src.slice(0, 15)), document.querySelector("a")?.title])',
          ),
        ).toBe(JSON.stringify([0, ['data:image/png;'], `${url}/page`]))
      },
    )
    expect(requests).toEqual([])
  } finally {
    server.close()
  }
})

test('a malformed file, bombs and a long sheet each say why', async () => {
  const long = workbook({ Long: Array.from({ length: 100_500 }, (_unused, row) => [row + 1]) })
  await withApp(
    {
      'broken.xlsx': new TextEncoder().encode('this is not a workbook'),
      'bomb.xlsx': zeroBomb(129 * MIB),
      'hidden.xlsx': hiddenDirectoryBomb(16 * MIB),
      'links.xlsx': hyperlinkRange('A1:XFD1048576'),
      'repeats.ods': odsRepeats(1_000_000, 1_000),
      'long.xlsx': long,
    },
    async (win, app) => {
      await openSheet(win, 'broken.xlsx')
      await guestText(app, 'broken.xlsx').toContain('Could not read this file.')
      await openSheet(win, 'bomb.xlsx')
      await guestText(app, 'bomb.xlsx').toContain('so it is not previewed')
      await openSheet(win, 'hidden.xlsx')
      await guestText(app, 'hidden.xlsx').toContain('Could not read this file.')
      await openSheet(win, 'links.xlsx')
      await guestText(app, 'links.xlsx').toContain('more than 2,000,000 cells')
      await openSheet(win, 'repeats.ods')
      await guestText(app, 'repeats.ods').toContain('more than 2,000,000 cells')
      await expect(win.locator('.topbar')).toBeVisible()

      await openSheet(win, 'long.xlsx')
      await guestText(app, 'long.xlsx').toContain('Showing the first 100,000 rows.')
      expect(
        await viewerGuestRun(
          app,
          { viewType: SHEET, name: 'long.xlsx' },
          'document.querySelectorAll("[role=rowheader]").length',
        ),
      ).toBeLessThan(200)
      await viewerGuestRun(
        app,
        { viewType: SHEET, name: 'long.xlsx' },
        'const s = document.querySelector(".ostia-grid-scroll"); s.scrollTop = s.scrollHeight',
      )
      await guestText(app, 'long.xlsx').toContain('100000')
    },
  )
})
