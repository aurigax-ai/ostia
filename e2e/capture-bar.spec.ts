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
import { test } from './test'

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
