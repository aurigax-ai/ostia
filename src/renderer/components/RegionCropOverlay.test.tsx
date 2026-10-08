import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RegionCropOverlay } from './RegionCropOverlay'

const LABEL = 'Region capture: drag over the page'

function layerAt(left: number, top: number, width: number, height: number): HTMLElement {
  const layer = screen.getByRole('application', { name: LABEL })
  vi.spyOn(layer, 'getBoundingClientRect').mockReturnValue({
    left,
    top,
    width,
    height,
    x: left,
    y: top,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  })
  return layer
}

function renderOverlay() {
  const onDone = vi.fn()
  const onCancel = vi.fn()
  render(<RegionCropOverlay label={LABEL} onDone={onDone} onCancel={onCancel} />)
  return { onDone, onCancel }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('RegionCropOverlay', () => {
  it('takes focus so Escape reaches it rather than the page', () => {
    renderOverlay()
    expect(screen.getByRole('application', { name: LABEL })).toHaveFocus()
  })

  it('draws the dragged rectangle with its size and reports it relative to the page area', () => {
    const { onDone } = renderOverlay()
    const layer = layerAt(100, 50, 800, 600)

    fireEvent.pointerDown(layer, { button: 0, clientX: 300, clientY: 150, pointerId: 1 })
    fireEvent.pointerMove(layer, { clientX: 200, clientY: 100, pointerId: 1 })

    const box = document.querySelector('.region-crop-box') as HTMLElement
    expect(box.style.left).toBe('100px')
    expect(box.style.top).toBe('50px')
    expect(box.style.width).toBe('100px')
    expect(screen.getByText('100 × 50')).toBeInTheDocument()
    expect(onDone).not.toHaveBeenCalled()

    fireEvent.pointerUp(layer, { clientX: 220, clientY: 130, pointerId: 1 })

    expect(onDone).toHaveBeenCalledWith(
      { x: 120, y: 80, width: 80, height: 20 },
      { width: 800, height: 600 },
    )
  })

  it('clamps a drag that leaves the page area to its edges', () => {
    const { onDone } = renderOverlay()
    const layer = layerAt(0, 0, 400, 300)
    fireEvent.pointerDown(layer, { button: 0, clientX: 350, clientY: 250, pointerId: 1 })
    fireEvent.pointerUp(layer, { clientX: 900, clientY: 900, pointerId: 1 })
    expect(onDone).toHaveBeenCalledWith(
      { x: 350, y: 250, width: 50, height: 50 },
      { width: 400, height: 300 },
    )
  })

  it('ignores a click or a sliver and stays in crop mode', () => {
    const { onDone, onCancel } = renderOverlay()
    const layer = layerAt(0, 0, 400, 300)
    fireEvent.pointerDown(layer, { button: 0, clientX: 10, clientY: 10, pointerId: 1 })
    fireEvent.pointerUp(layer, { clientX: 12, clientY: 40, pointerId: 1 })
    expect(onDone).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
    expect(document.querySelector('.region-crop-box')).toBeNull()
  })

  it('ignores buttons other than the primary one', () => {
    const { onDone } = renderOverlay()
    const layer = layerAt(0, 0, 400, 300)
    fireEvent.pointerDown(layer, { button: 2, clientX: 10, clientY: 10, pointerId: 1 })
    fireEvent.pointerUp(layer, { clientX: 100, clientY: 100, pointerId: 1 })
    expect(onDone).not.toHaveBeenCalled()
  })

  it('cancels on Escape', () => {
    const { onCancel, onDone } = renderOverlay()
    fireEvent.keyDown(screen.getByRole('application', { name: LABEL }), { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onDone).not.toHaveBeenCalled()
  })
})
