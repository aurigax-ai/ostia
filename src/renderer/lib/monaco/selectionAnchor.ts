import { anchorWithin, type BarAnchor } from '@/lib/agents/barAnchor'
import type { monaco } from './setup'

export function editorSelectionAnchor(
  editor: monaco.editor.IStandaloneCodeEditor,
): BarAnchor | undefined {
  const selection = editor.getSelection()
  const dom = editor.getDomNode()
  const container = editor.getContainerDomNode().offsetParent
  if (!selection || !dom || !container) return undefined
  const start = editor.getScrolledVisiblePosition(selection.getStartPosition())
  const end = editor.getScrolledVisiblePosition(selection.getEndPosition())
  if (!start || !end) return undefined
  const box = dom.getBoundingClientRect()
  return anchorWithin(container, {
    left: box.left + end.left,
    top: box.top + start.top,
    bottom: box.top + end.top + end.height,
  })
}
