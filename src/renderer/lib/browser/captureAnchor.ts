import type { PickBox } from '@shared/browser/pick'
import { anchorWithin, type BarAnchor } from '@/lib/agents/barAnchor'

const STAGE = '.browser-stage'

export function pageBoxAnchor(
  webview: HTMLElement,
  box: PickBox,
  viewport: { width: number; height: number },
): BarAnchor | null {
  const stage = webview.closest(STAGE)
  if (!stage || viewport.width <= 0) return null
  const view = webview.getBoundingClientRect()
  const scale = view.width / viewport.width
  return anchorWithin(stage, {
    left: view.left + box.x * scale,
    top: view.top + box.y * scale,
    bottom: view.top + (box.y + box.height) * scale,
  })
}

export function layerRectAnchor(webview: HTMLElement, rect: PickBox): BarAnchor | null {
  const stage = webview.closest(STAGE)
  if (!stage) return null
  const view = webview.getBoundingClientRect()
  return anchorWithin(stage, {
    left: view.left + rect.x,
    top: view.top + rect.y,
    bottom: view.top + rect.y + rect.height,
  })
}
