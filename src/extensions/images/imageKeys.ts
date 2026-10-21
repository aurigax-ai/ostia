import type { ImageSelection } from './imageSelection'
import { stepZoom } from './imageZoom'
import type { ZoomView } from './imageZoomView'

function inPill(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('.ostia-pill') !== null
}

export function bindKeys(parts: { view: ZoomView; selection: ImageSelection }): void {
  const { view, selection } = parts
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      selection.deselect()
      return
    }
    if (inPill(event.target) || event.code === 'Space') return
    if (event.ctrlKey || event.metaKey) {
      if (event.key.toLowerCase() === 'a') {
        event.preventDefault()
        selection.select(null)
      }
      return
    }
    if (event.altKey) return
    if (event.key === '+' || event.key === '=') view.setZoom(stepZoom(view.scale(), 1))
    else if (event.key === '-') view.setZoom(stepZoom(view.scale(), -1))
    else if (event.key === '0') view.setZoom('fit')
    else if (event.key === '1') view.setZoom(1)
  })
}
