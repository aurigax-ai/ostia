import { openSelectionSend } from '@/lib/agents/selectionSenders'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TARGET_PANE, seedSendTarget } from '../../../../test/mocks/sendTarget'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7])

vi.mock('@/lib/browser/cropImage', () => ({ cropToPng: vi.fn() }))

const { cropToPng } = await import('@/lib/browser/cropImage')
const { ImageViewer } = await import('./ImageViewer')

let unseed: () => void

beforeEach(() => {
  unseed = seedSendTarget('w1')
  URL.createObjectURL = vi.fn(() => 'blob:img-1')
  URL.revokeObjectURL = vi.fn()
  vi.mocked(cropToPng).mockResolvedValue(PNG)
  vi.mocked(window.ostia.selection.send).mockResolvedValue({
    ok: true,
    path: '/tmp/ostia-reports-1/selection-1.md',
    imagePath: '/tmp/ostia-reports-1/selection-1.png',
  })
})

afterEach(() => {
  cleanup()
  unseed()
  vi.mocked(cropToPng).mockReset()
})

async function renderLoaded(width = 400, height = 200): Promise<HTMLImageElement> {
  vi.mocked(window.ostia.fs.readBinary).mockResolvedValue({ ok: true, data: PNG })
  render(<ImageViewer workspaceId="w1" paneId="img-pane" filePath="/w/shots/login.png" />)
  const img = await waitFor(() => {
    const found = document.querySelector<HTMLImageElement>('img[alt="login.png"]')
    if (!found) throw new Error('image not rendered')
    return found
  })
  Object.defineProperty(img, 'naturalWidth', { value: width })
  Object.defineProperty(img, 'naturalHeight', { value: height })
  fireEvent.load(img)
  await screen.findByText(`${width} × ${height}`)
  return img
}

function canvasAt(left: number, top: number): HTMLElement {
  const canvas = document.querySelector('.viewer-canvas') as HTMLElement
  canvas.getBoundingClientRect = () =>
    ({ left, top, width: 0, height: 0, right: 0, bottom: 0, x: left, y: top }) as DOMRect
  return canvas
}

describe('ImageViewer', () => {
  it('reads the image through the confined binary IPC and shows it from a blob URL', async () => {
    const img = await renderLoaded()
    expect(window.ostia.fs.readBinary).toHaveBeenCalledWith('/w/shots/login.png')
    expect(img).toHaveAttribute('src', 'blob:img-1')
    expect(screen.getByText('Zoom 100%')).toBeInTheDocument()
  })

  it('marks the canvas as a region-select surface only once the image has loaded', async () => {
    vi.mocked(window.ostia.fs.readBinary).mockResolvedValue({ ok: true, data: PNG })
    render(<ImageViewer workspaceId="w1" paneId="img-pane" filePath="/w/shots/login.png" />)
    const img = await waitFor(() => {
      const found = document.querySelector<HTMLImageElement>('img[alt="login.png"]')
      if (!found) throw new Error('image not rendered')
      return found
    })
    const canvas = document.querySelector('.viewer-canvas') as HTMLElement
    expect(canvas).not.toHaveClass('region-select')
    Object.defineProperty(img, 'naturalWidth', { value: 40 })
    Object.defineProperty(img, 'naturalHeight', { value: 20 })
    fireEvent.load(img)
    await waitFor(() => expect(canvas).toHaveClass('region-select'))
  })

  it('explains a file over the size cap instead of showing it', async () => {
    vi.mocked(window.ostia.fs.readBinary).mockResolvedValue({
      ok: false,
      error: 'too-large',
      size: 60 * 1024 * 1024,
    })
    render(<ImageViewer workspaceId="w1" paneId="img-pane" filePath="/w/huge.png" />)
    expect(await screen.findByText('This file is too large to preview (60.0 MB).')).toBeVisible()
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('zooms in and out in steps and returns to fit', async () => {
    await renderLoaded()
    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(screen.getByText('Zoom 125%')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Zoom out' }))
    await userEvent.click(screen.getByRole('button', { name: 'Zoom out' }))
    expect(screen.getByText('Zoom 75%')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Fit to pane' }))
    expect(screen.getByRole('button', { name: 'Fit to pane' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('zooms with a pinch or Ctrl+wheel and leaves a plain wheel to scroll', async () => {
    await renderLoaded()
    const stage = document.querySelector('.viewer-stage') as HTMLElement
    canvasAt(16, 16)

    expect(fireEvent.wheel(stage, { deltaY: -40, clientX: 50, clientY: 40 })).toBe(true)
    expect(screen.getByText('Zoom 100%')).toBeInTheDocument()

    expect(fireEvent.wheel(stage, { deltaY: -40, ctrlKey: true, clientX: 50, clientY: 40 })).toBe(
      false,
    )
    expect(await screen.findByText('Zoom 149%')).toBeInTheDocument()

    fireEvent.wheel(stage, { deltaY: 40, ctrlKey: true, clientX: 50, clientY: 40 })
    expect(await screen.findByText('Zoom 100%')).toBeInTheDocument()
  })

  it('crops a dragged region in image pixels and sends it with the PNG', async () => {
    const img = await renderLoaded()
    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(screen.getByText('Zoom 150%')).toBeInTheDocument()
    const canvas = canvasAt(100, 50)

    fireEvent.pointerDown(canvas, { button: 0, clientX: 130, clientY: 80, pointerId: 1 })
    fireEvent.pointerMove(canvas, { clientX: 280, clientY: 155, pointerId: 1 })
    fireEvent.pointerUp(canvas, { clientX: 280, clientY: 155, pointerId: 1 })

    const region = document.querySelector('.viewer-region') as HTMLElement
    expect(region.style.width).toBe('150px')
    await userEvent.click(screen.getByRole('button', { name: 'Send region to agent' }))

    const region20 = { x: 20, y: 20, width: 100, height: 50 }
    expect(cropToPng).toHaveBeenCalledWith(img, region20)
    const panel = await screen.findByRole('region', { name: 'Send to agent' })
    expect(panel).toHaveTextContent('login.png (x 20, y 20, 100 × 50)')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(window.ostia.selection.send).toHaveBeenCalledWith({
        capture: {
          kind: 'image',
          file: '/w/shots/login.png',
          imageWidth: 400,
          imageHeight: 200,
          region: region20,
        },
        image: PNG,
        sourcePaneId: 'img-pane',
        targetPaneId: TARGET_PANE,
        note: '',
      }),
    )
  })

  it('sends the whole image when no region is drawn, and Escape clears a region', async () => {
    const img = await renderLoaded(64, 32)
    const canvas = canvasAt(0, 0)
    fireEvent.pointerDown(canvas, { button: 0, clientX: 1, clientY: 1, pointerId: 1 })
    fireEvent.pointerUp(canvas, { clientX: 30, clientY: 20, pointerId: 1 })
    expect(document.querySelector('.viewer-region')).not.toBeNull()
    fireEvent.keyDown(canvas, { key: 'Escape' })
    expect(document.querySelector('.viewer-region')).toBeNull()

    act(() => {
      openSelectionSend('img-pane')
    })

    await screen.findByRole('region', { name: 'Send to agent' })
    expect(cropToPng).toHaveBeenCalledWith(img, { x: 0, y: 0, width: 64, height: 32 })
    expect(screen.getByRole('button', { name: 'Send image to agent' })).toBeInTheDocument()
  })

  it('ignores a click that does not drag out a region', async () => {
    await renderLoaded()
    const canvas = canvasAt(0, 0)
    fireEvent.pointerDown(canvas, { button: 0, clientX: 10, clientY: 10, pointerId: 1 })
    fireEvent.pointerUp(canvas, { clientX: 10, clientY: 10, pointerId: 1 })
    expect(document.querySelector('.viewer-region')).toBeNull()
  })
})
