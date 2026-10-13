import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TARGET_PANE, seedSendTarget } from '../../../../test/mocks/sendTarget'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9])

const fake = vi.hoisted(() => {
  const pageText = ['Invoice total: 42', 'Second page']
  const makePage = (n: number) => ({
    getViewport: ({ scale }: { scale: number }) => ({
      width: 600 * scale,
      height: 800 * scale,
      scale,
    }),
    render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
    streamTextContent: () => n,
    getTextContent: () => Promise.resolve({ items: [{ str: pageText[n - 1] }] }),
  })
  class TextLayer {
    constructor(private opts: { textContentSource: number; container: HTMLElement }) {}
    render() {
      const span = document.createElement('span')
      span.textContent = pageText[this.opts.textContentSource - 1]
      this.opts.container.appendChild(span)
      return Promise.resolve()
    }
    cancel() {}
  }
  const doc = {
    get numPages() {
      return pageText.length
    },
    getPage: vi.fn((n: number) => Promise.resolve(makePage(n))),
    loadingTask: { destroy: vi.fn(() => Promise.resolve()) },
  }
  return { doc, pageText, TextLayer, openPdf: vi.fn(() => Promise.resolve(doc)) }
})

vi.mock('@/lib/files/pdf', () => ({
  openPdf: fake.openPdf,
  loadPdfjs: () => Promise.resolve({ TextLayer: fake.TextLayer }),
}))
vi.mock('@/lib/browser/cropImage', () => ({ cropToPng: vi.fn() }))

const { cropToPng } = await import('@/lib/browser/cropImage')
const { PdfViewer } = await import('./PdfViewer')
const { usePdfFindStore } = await import('@/stores/files/pdfFindStore')

let unseed: () => void

beforeEach(() => {
  unseed = seedSendTarget('w1')
  vi.mocked(window.ostia.fs.readBinary).mockResolvedValue({ ok: true, data: new Uint8Array([37]) })
  vi.mocked(cropToPng).mockResolvedValue(PNG)
  vi.mocked(window.ostia.selection.send).mockResolvedValue({
    ok: true,
    path: '/tmp/ostia-reports-1/selection-1.md',
    imagePath: null,
  })
})

afterEach(() => {
  cleanup()
  unseed()
  vi.mocked(cropToPng).mockReset()
})

async function renderPdf(): Promise<void> {
  render(<PdfViewer workspaceId="w1" paneId="pdf-pane" filePath="/w/docs/invoice.pdf" />)
  await screen.findByText('Page 1 of 2')
  await screen.findByText('Invoice total: 42')
}

function selectText(node: Node, start: number, end: number): void {
  const range = document.createRange()
  range.setStart(node, start)
  range.setEnd(node, end)
  document.getSelection()?.removeAllRanges()
  document.getSelection()?.addRange(range)
  act(() => {
    document.dispatchEvent(new Event('selectionchange'))
  })
}

describe('PdfViewer', () => {
  it('opens the PDF from the confined binary read and pages through it', async () => {
    await renderPdf()
    expect(window.ostia.fs.readBinary).toHaveBeenCalledWith('/w/docs/invoice.pdf')
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }))
    expect(await screen.findByText('Page 2 of 2')).toBeInTheDocument()
    expect(await screen.findByText('Second page')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled()
  })

  it('shows an error when the file is not a PDF it can open', async () => {
    fake.openPdf.mockRejectedValueOnce(new Error('Invalid PDF structure'))
    render(<PdfViewer workspaceId="w1" paneId="pdf-pane" filePath="/w/broken.pdf" />)
    expect(await screen.findByText('Could not open this PDF.')).toBeInTheDocument()
  })

  it('sends selected text with its page number', async () => {
    await renderPdf()
    selectText(screen.getByText('Invoice total: 42').firstChild as Node, 0, 13)

    const send = screen.getByRole('button', { name: 'Send selected text to agent' })
    await userEvent.click(send)
    const panel = await screen.findByRole('region', { name: 'Send to agent' })
    expect(panel).toHaveTextContent('invoice.pdf, page 1')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() =>
      expect(window.ostia.selection.send).toHaveBeenCalledWith({
        capture: {
          kind: 'pdf-text',
          file: '/w/docs/invoice.pdf',
          firstPage: 1,
          lastPage: 1,
          text: 'Invoice total',
        },
        sourcePaneId: 'pdf-pane',
        targetPaneId: TARGET_PANE,
        note: '',
      }),
    )
    expect(cropToPng).not.toHaveBeenCalled()
  })

  it('follows a pinch at once and redraws the page once it settles', async () => {
    await renderPdf()
    const page = await (fake.doc.getPage.mock.results.at(-1)?.value as Promise<{
      render: ReturnType<typeof vi.fn>
    }>)
    await waitFor(() => expect(page.render).toHaveBeenCalled())
    const drawn = page.render.mock.calls.length
    const stage = document.querySelector('.viewer-stage') as HTMLElement

    for (let i = 0; i < 4; i++) fireEvent.wheel(stage, { deltaY: -10, ctrlKey: true })
    expect(await screen.findByText('Zoom 149%')).toBeInTheDocument()
    expect(page.render).toHaveBeenCalledTimes(drawn)

    await waitFor(() => expect(page.render).toHaveBeenCalledTimes(drawn + 1))
    const [{ viewport }] = page.render.mock.calls[drawn] as [{ viewport: { scale: number } }]
    expect(viewport.scale).toBeCloseTo(Math.exp(0.4))
  })

  it('draws a newly opened page once, at its fit width', async () => {
    const width = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.classList.contains('viewer-stage') ? 1232 : 0
      })
    try {
      await renderPdf()
      const page = await (fake.doc.getPage.mock.results.at(-1)?.value as Promise<{
        render: ReturnType<typeof vi.fn>
      }>)
      await waitFor(() => expect(page.render).toHaveBeenCalled())
      await new Promise((resolve) => setTimeout(resolve, 300))

      expect(page.render).toHaveBeenCalledTimes(1)
      const [{ viewport }] = page.render.mock.calls[0] as [{ viewport: { scale: number } }]
      expect(viewport.scale).toBe(2)
    } finally {
      width.mockRestore()
    }
  })

  it('shows the region-select surface only in region mode', async () => {
    await renderPdf()
    expect(document.querySelector('.region-select')).toBeNull()
    const toggle = screen.getByRole('button', { name: 'Select a region' })
    await userEvent.click(toggle)
    expect(document.querySelector('.pdf-region-layer')).toHaveClass('region-select')
    await userEvent.click(toggle)
    expect(document.querySelector('.region-select')).toBeNull()
  })

  it('snapshots a dragged region of the page canvas in PDF points', async () => {
    await renderPdf()
    await userEvent.click(screen.getByRole('button', { name: 'Select a region' }))
    expect(screen.getByText('Drag across the page to select a region.')).toBeInTheDocument()
    const layer = document.querySelector('.pdf-region-layer') as HTMLElement
    layer.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 600, height: 800, right: 600, bottom: 800, x: 0, y: 0 }) as DOMRect

    fireEvent.pointerDown(layer, { button: 0, clientX: 60, clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(layer, { clientX: 260, clientY: 150, pointerId: 1 })
    fireEvent.pointerUp(layer, { clientX: 260, clientY: 150, pointerId: 1 })

    await userEvent.click(screen.getByRole('button', { name: 'Send region to agent' }))
    await screen.findByRole('region', { name: 'Send to agent' })
    const canvas = document.querySelector('canvas') as HTMLCanvasElement
    expect(cropToPng).toHaveBeenCalledWith(canvas, { x: 60, y: 100, width: 200, height: 50 })
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(window.ostia.selection.send).toHaveBeenCalledWith(
        expect.objectContaining({
          capture: {
            kind: 'pdf-region',
            file: '/w/docs/invoice.pdf',
            page: 1,
            pageWidth: 600,
            pageHeight: 800,
            region: { x: 60, y: 100, width: 200, height: 50 },
          },
          image: PNG,
        }),
      ),
    )
  })

  it('a pinch zooms the PDF page and a region drag still selects', async () => {
    const width = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.classList.contains('viewer-stage') ? 1232 : 0
      })
    try {
      await renderPdf()
      const pdfPage = await (fake.doc.getPage.mock.results.at(-1)?.value as Promise<{
        render: ReturnType<typeof vi.fn>
      }>)
      await waitFor(() => expect(pdfPage.render).toHaveBeenCalled())
      const drawn = pdfPage.render.mock.calls.length
      expect(screen.getByText('Zoom 200%')).toBeInTheDocument()
      const page = document.querySelector('.pdf-page') as HTMLElement
      const start = Number.parseFloat(page.style.width)
      const stage = document.querySelector('.viewer-stage') as HTMLElement

      fireEvent.wheel(stage, { deltaY: 40, ctrlKey: true, clientX: 40, clientY: 40 })
      expect(
        await screen.findByText(`Zoom ${Math.round(200 * Math.exp(-0.4))}%`),
      ).toBeInTheDocument()
      expect(Number.parseFloat(page.style.width)).toBeLessThan(start)
      await waitFor(() => expect(pdfPage.render).toHaveBeenCalledTimes(drawn + 1))

      await userEvent.click(screen.getByRole('button', { name: 'Select a region' }))
      const layer = document.querySelector('.pdf-region-layer') as HTMLElement
      layer.getBoundingClientRect = () =>
        ({
          left: 0,
          top: 0,
          width: 600,
          height: 800,
          right: 600,
          bottom: 800,
          x: 0,
          y: 0,
        }) as DOMRect
      fireEvent.pointerDown(layer, { button: 0, clientX: 10, clientY: 10, pointerId: 1 })
      fireEvent.pointerMove(layer, { clientX: 70, clientY: 50, pointerId: 1 })
      fireEvent.pointerUp(layer, { clientX: 70, clientY: 50, pointerId: 1 })
      const region = document.querySelector('.viewer-region') as HTMLElement
      expect(Math.abs(Number.parseFloat(region.style.width) - 60)).toBeLessThan(6)
      expect(Math.abs(Number.parseFloat(region.style.height) - 40)).toBeLessThan(6)
    } finally {
      width.mockRestore()
    }
  })

  it('PDF text is found from the Files panel and with find in the PDF viewer', async () => {
    const pages = fake.pageText.splice(
      0,
      fake.pageText.length,
      'Introduction',
      'A needle on page two',
      'Another needle and one more needle',
    )
    const highlights = new Map<string, { size: number }>()
    vi.stubGlobal('CSS', { highlights })
    vi.stubGlobal(
      'Highlight',
      class {
        size: number
        constructor(...ranges: Range[]) {
          this.size = ranges.length
        }
      },
    )
    try {
      usePdfFindStore.getState().request('/w/docs/paper.pdf', { page: 3, query: 'needle' })
      render(<PdfViewer workspaceId="w1" paneId="pdf-pane" filePath="/w/docs/paper.pdf" />)
      const input = screen.getByRole('textbox', { name: 'Find in PDF' })
      expect(input).toHaveValue('needle')
      expect(await screen.findByText('Page 3 of 3')).toBeInTheDocument()
      const find = document.querySelector('.pdf-find') as HTMLElement
      await waitFor(() => expect(find).toHaveTextContent('2/3'))

      fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
      expect(find).toHaveTextContent('1/3')
      expect(await screen.findByText('Page 2 of 3')).toBeInTheDocument()
      await screen.findByText('A needle on page two')
      await waitFor(() => expect(highlights.get('ostia-find')?.size).toBe(1))

      fireEvent.keyDown(input, { key: 'Escape' })
      expect(document.querySelector('.pdf-find')).toBeNull()
      const textLayer = document.querySelector('.pdf-text') as HTMLElement
      await userEvent.click(textLayer)
      fireEvent.keyDown(textLayer, { key: 'f', ctrlKey: true })
      expect(screen.getByRole('textbox', { name: 'Find in PDF' })).toHaveFocus()
    } finally {
      vi.unstubAllGlobals()
      fake.pageText.splice(0, fake.pageText.length, ...pages)
    }
  })

  it('sends the whole page when nothing is selected', async () => {
    await renderPdf()
    await userEvent.click(screen.getByRole('button', { name: 'Send page to agent' }))
    await screen.findByRole('region', { name: 'Send to agent' })
    const canvas = document.querySelector('canvas') as HTMLCanvasElement
    expect(cropToPng).toHaveBeenCalledWith(canvas, {
      x: 0,
      y: 0,
      width: canvas.width,
      height: canvas.height,
    })
  })
})
