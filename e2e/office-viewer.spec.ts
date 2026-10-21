import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { cfbBomb } from '../test/fixtures/office/cfbBomb'
import {
  ODP_MIMETYPE,
  ODT_MIMETYPE,
  odf,
  odpFrame,
  odpNotes,
  odpPage,
  para,
  pptx,
  relationship,
  run,
  shape,
  picture as slidePicture,
  titleShape,
} from '../test/fixtures/office/presentations'
import {
  docx,
  externalLinkWorkbook,
  externalRelationship,
  macroWorkbook,
  paragraph,
  picture,
  workbook,
} from '../test/fixtures/office/workbooks'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'
import { type ElectronApplication, _electron as electron, expect, type Page, test } from './test'
import { viewerGuestRun, viewerGuestText } from './viewerGuest'

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

async function openViewer(win: Page, name: string, viewType: string): Promise<void> {
  await win.locator('.file-row').filter({ hasText: name }).click()
  await expect(win.locator('[data-testid="file-viewer"]:visible')).toHaveAttribute(
    'data-view-type',
    viewType,
    { timeout: 15_000 },
  )
}

function openSheet(win: Page, name: string): Promise<void> {
  return openViewer(win, name, SHEET)
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

test('a malformed file and a long sheet each say why, and a bomb is stopped', async () => {
  const long = workbook({ Long: Array.from({ length: 100_500 }, (_unused, row) => [row + 1]) })
  await withApp(
    {
      'broken.xlsx': new TextEncoder().encode('this is not a workbook'),
      'bomb.xls': cfbBomb(2000),
      'long.xlsx': long,
    },
    async (win, app) => {
      await openSheet(win, 'broken.xlsx')
      await guestText(app, 'broken.xlsx').toContain('Could not read this file.')

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

      await openSheet(win, 'bomb.xls')
      const stopped = win.getByTestId('viewer-stopped')
      await expect(stopped).toBeVisible({ timeout: 20_000 })
      await expect(stopped.getByRole('button', { name: 'Reload' })).toBeVisible()
      await openSheet(win, 'broken.xlsx')
      await guestText(app, 'broken.xlsx').toContain('Could not read this file.')
    },
  )
})

test('presentations and OpenDocument text open as outlines, fetch nothing and say why when they cannot', async () => {
  const requests: string[] = []
  const server: Server = createServer((req, res) => {
    requests.push(req.url ?? '')
    res.end('nothing')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const SLIDES = 'office.presentation'
  const DOC = 'office.document'
  const deck = pptx({
    slides: [
      {
        shapes:
          titleShape('Quarter review') +
          shape(para(run('Revenue grew')) + para(run('site', 'rWeb')), '') +
          slidePicture('Logo'),
        relationships:
          relationship('rImg', 'image', `${url}/far.png`, true) +
          relationship('rWeb', 'hyperlink', `${url}/page`, true),
        notes: 'Thank the team',
      },
    ],
  })
  try {
    await withApp(
      {
        'deck.pptx': deck,
        'deck.odp': odf(ODP_MIMETYPE, {
          body: odpPage(
            'p1',
            odpFrame('title', '<text:p>Roadmap</text:p>') +
              odpFrame('outline', '<text:p>Next steps</text:p>') +
              odpNotes('Ask for questions'),
          ),
        }),
        'minutes.odt': odf(ODT_MIMETYPE, {
          body: `<text:h text:outline-level="1">Minutes</text:h><text:p>&lt;img src=x onerror=alert(1)&gt;</text:p><text:p><draw:frame><draw:image xlink:href="${url}/far.png"/></draw:frame></text:p>`,
        }),
        'notes.doc': new Uint8Array(
          readFileSync(join(__dirname, '../test/fixtures/office/doc/test01.doc')),
        ),
        'broken.pptx': new TextEncoder().encode('this is not a presentation'),
        'renamed.pptx': docx({ body: paragraph('a word document') }),
      },
      async (win, app) => {
        const slides = (name: string) => ({ viewType: SLIDES, name })
        await openViewer(win, 'deck.pptx', SLIDES)
        await expect
          .poll(() => viewerGuestText(app, slides('deck.pptx')), { timeout: 20_000 })
          .toContain('Quarter review')
        const pptxText = await viewerGuestText(app, slides('deck.pptx'))
        expect(pptxText).toContain('Revenue grew')
        expect(pptxText).toContain('[Image: Logo]')
        expect(pptxText).toContain('Thank the team')
        expect(
          await viewerGuestRun(
            app,
            slides('deck.pptx'),
            'JSON.stringify([document.querySelectorAll("article :is(a[href], img, [src])").length, document.querySelector("article a")?.title])',
          ),
        ).toBe(JSON.stringify([0, `${url}/page`]))

        await openViewer(win, 'deck.odp', SLIDES)
        await expect
          .poll(() => viewerGuestText(app, slides('deck.odp')), { timeout: 20_000 })
          .toContain('Roadmap')
        expect(await viewerGuestText(app, slides('deck.odp'))).toContain('Ask for questions')

        await openViewer(win, 'minutes.odt', DOC)
        const doc = { viewType: DOC, name: 'minutes.odt' }
        await expect.poll(() => viewerGuestText(app, doc), { timeout: 20_000 }).toContain('Minutes')
        expect(await viewerGuestText(app, doc)).toContain('<img src=x onerror=alert(1)>')
        expect(await viewerGuestRun(app, doc, 'document.images.length')).toBe(0)

        await openViewer(win, 'notes.doc', DOC)
        await expect
          .poll(() => viewerGuestText(app, { viewType: DOC, name: 'notes.doc' }), {
            timeout: 20_000,
          })
          .toContain('A second test of reviewing')

        await openViewer(win, 'broken.pptx', SLIDES)
        await expect
          .poll(() => viewerGuestText(app, slides('broken.pptx')), { timeout: 20_000 })
          .toContain('Could not read this file.')
        await openViewer(win, 'renamed.pptx', SLIDES)
        await expect
          .poll(() => viewerGuestText(app, slides('renamed.pptx')), { timeout: 20_000 })
          .toContain('Could not read this file.')
      },
    )
    expect(requests).toEqual([])
  } finally {
    server.close()
  }
})
