import { describe, expect, it, vi } from 'vitest'
import { bindGestures } from './imageGestures'

function setup() {
  const stage = document.createElement('div')
  const canvas = document.createElement('div')
  stage.append(canvas)
  document.body.append(stage)
  stage.setPointerCapture = vi.fn()
  const selection = { select: vi.fn(), deselect: vi.fn(), preview: vi.fn() }
  const view = {
    contentPoint: (p: { x: number; y: number }) => p,
    scale: () => 1,
    setZoom: vi.fn(),
  }
  bindGestures({
    stage,
    canvas,
    natural: { width: 100, height: 100 },
    view: view as never,
    selection,
  })
  return { stage, canvas, selection }
}

function fire(target: Element, type: string, init: MouseEventInit): Event {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

describe('middle-button pan', () => {
  it('scrolls the stage without cropping or deselecting', () => {
    const { stage, canvas, selection } = setup()
    stage.scrollLeft = 50
    stage.scrollTop = 40
    const down = fire(canvas, 'pointerdown', { button: 1, clientX: 100, clientY: 100 })
    expect(down.defaultPrevented).toBe(true)
    expect(stage.dataset.pan).toBe('active')
    fire(stage, 'pointermove', { clientX: 90, clientY: 70 })
    expect(stage.scrollLeft).toBe(60)
    expect(stage.scrollTop).toBe(70)
    fire(stage, 'pointerup', { button: 1, clientX: 90, clientY: 70 })
    expect(stage.dataset.pan).toBeUndefined()
    expect(selection.deselect).not.toHaveBeenCalled()
    expect(selection.select).not.toHaveBeenCalled()
    expect(selection.preview).not.toHaveBeenCalled()
  })

  it('stops the autoscroll press and the aux click', () => {
    const { canvas } = setup()
    expect(fire(canvas, 'mousedown', { button: 1 }).defaultPrevented).toBe(true)
    expect(fire(canvas, 'auxclick', { button: 1 }).defaultPrevented).toBe(true)
  })
})
