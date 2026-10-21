import { afterEach, describe, expect, it } from 'vitest'
import { layerRectAnchor, pageBoxAnchor } from './captureAnchor'

function rectOf(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    x: left,
    y: top,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  }
}

function stageWith(stage: DOMRect, view: DOMRect): HTMLElement {
  const stageEl = document.createElement('div')
  stageEl.className = 'browser-stage'
  const webview = document.createElement('webview')
  stageEl.append(webview)
  document.body.append(stageEl)
  stageEl.getBoundingClientRect = () => stage
  webview.getBoundingClientRect = () => view
  return webview
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('pageBoxAnchor', () => {
  it('places a page box in the stage, scaled by how much the page is shown', () => {
    const webview = stageWith(rectOf(100, 50, 0, 0), rectOf(120, 80, 400, 300))
    expect(
      pageBoxAnchor(webview, { x: 10, y: 20, width: 100, height: 40 }, { width: 800, height: 600 }),
    ).toEqual({ left: 25, top: 40, bottom: 60 })
  })

  it('has no anchor outside a stage or for an empty viewport', () => {
    const lone = document.createElement('webview')
    expect(
      pageBoxAnchor(lone, { x: 0, y: 0, width: 1, height: 1 }, { width: 800, height: 600 }),
    ).toBeNull()
    const webview = stageWith(rectOf(0, 0, 0, 0), rectOf(0, 0, 400, 300))
    expect(
      pageBoxAnchor(webview, { x: 0, y: 0, width: 1, height: 1 }, { width: 0, height: 0 }),
    ).toBeNull()
  })
})

describe('layerRectAnchor', () => {
  it('places a rectangle dragged over the page in the stage', () => {
    const webview = stageWith(rectOf(100, 50, 0, 0), rectOf(100, 50, 640, 480))
    expect(layerRectAnchor(webview, { x: 10, y: 20, width: 120, height: 80 })).toEqual({
      left: 10,
      top: 20,
      bottom: 100,
    })
  })
})
