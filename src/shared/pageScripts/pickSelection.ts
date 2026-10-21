/// <reference lib="dom" />
import type { PickSelection } from '../browser/pickRuntime'

export function createSelectionReader(win: Window & typeof globalThis) {
  const selection = (): PickSelection | null => {
    const current = win.getSelection()
    const text = current?.toString() ?? ''
    if (!current || current.rangeCount === 0 || text.trim() === '') return null
    const r = current.getRangeAt(0).getBoundingClientRect()
    return {
      url: win.location.href,
      title: win.document.title,
      text,
      box: { x: r.x, y: r.y, width: r.width, height: r.height },
      viewport: { width: win.innerWidth, height: win.innerHeight },
    }
  }
  return { selection }
}
