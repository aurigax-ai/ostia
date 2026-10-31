import {
  browserPickSurface,
  browserRegionSurface,
  browserTableSurface,
  browserTextSurface,
  previewPickSurface,
  previewRegionSurface,
} from './captureBrowserSurfaces'
import { runCaptureMatrix } from './captureMatrix'
import { csvViewerSurface, monacoSurface, terminalSurface } from './captureSurfaces'
import {
  imageViewerSurface,
  markdownViewerSurface,
  pdfViewerSurface,
} from './captureViewerSurfaces'
import { expect, test } from './test'
import { viewerGuestRun } from './viewerGuest'

const SURFACES = [
  terminalSurface,
  monacoSurface,
  browserPickSurface,
  browserTableSurface,
  browserTextSurface,
  browserRegionSurface,
  previewPickSurface,
  previewRegionSurface,
  csvViewerSurface,
  pdfViewerSurface,
  imageViewerSurface,
  markdownViewerSurface,
]

for (const surface of SURFACES) {
  test(`${surface.name} follows the capture bar behaviour table`, async () => {
    test.setTimeout(180_000)
    await runCaptureMatrix(surface)
  })
}

test('viewer-csv keeps its selection while the file grows and drops it when a row changes', async () => {
  test.setTimeout(120_000)
  const launched = await csvViewerSurface.launch()
  const { app, win, open, cleared, close, file } = launched
  if (!file) throw new Error('the csv surface has no file')
  try {
    const bar = win.getByRole('toolbar', { name: 'Selection actions' })
    await open()
    await expect(bar).toBeVisible({ timeout: 15_000 })
    await file.append(25, 200)
    await expect
      .poll(() =>
        viewerGuestRun(
          app,
          { viewType: 'csv.table', name: 'orders.csv' },
          'document.querySelector("[role=grid]").getAttribute("aria-rowcount")',
        ),
      )
      .toBe('30')
    await expect(bar).toBeVisible()
    await expect
      .poll(() =>
        viewerGuestRun(
          app,
          { viewType: 'csv.table', name: 'orders.csv' },
          'document.querySelectorAll(".ostia-grid-selected").length',
        ),
      )
      .toBeGreaterThan(0)
    await app.evaluate(({ clipboard }) => clipboard.writeText('marker'))
    await bar.getByRole('button', { name: 'Copy' }).click()
    await expect(win.getByTestId('capture-chip')).toHaveText('Copied table')
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(
      'Taipei,3\n"Hsinchu, East",4\nTainan,5',
    )
    await open()
    await expect(bar).toBeVisible({ timeout: 15_000 })
    file.editMiddleRow()
    await expect(bar).toBeHidden({ timeout: 15_000 })
    await cleared()
  } finally {
    await close()
  }
})
