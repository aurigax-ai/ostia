import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TARGET_PANE, seedSendTarget } from '../../../../test/mocks/sendTarget'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9])

const fake = vi.hoisted(() => {
  const pageText: Record<number, string> = { 1: 'Invoice total: 42', 2: 'Second page' }
  const makePage = (n: number) => ({
    getViewport: ({ scale }: { scale: number }) => ({
      width: 600 * scale,
      height: 800 * scale,
      scale,
    }),
    render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
    streamTextContent: () => n,
  })
  class TextLayer {
    constructor(private opts: { textContentSource: number; container: HTMLElement }) {}
    render() {
      const span = document.createElement('span')
      span.textContent = pageText[this.opts.textContentSource]
      this.opts.container.appendChild(span)
      return Promise.resolve()
    }
    cancel() {}
  }
  const doc = {
    numPages: 2,
    getPage: vi.fn((n: number) => Promise.resolve(makePage(n))),
    loadingTask: { destroy: vi.fn(() => Promise.resolve()) },
  }
  return { doc, TextLayer, openPdf: vi.fn(() => Promise.resolve(doc)) }
})

vi.mock('@/lib/pdf', () => ({
  openPdf: fake.openPdf,
  loadPdfjs: () => Promise.resolve({ TextLayer: fake.TextLayer }),
}))
vi.mock('@/lib/cropImage', () => ({ cropToPng: vi.fn() }))

const { cropToPng } = await import('@/lib/cropImage')
const { PdfViewer } = await import('./PdfViewer')

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
