export function trackSelection(
  root: HTMLElement,
  onChange: (range: Range | null) => void,
): () => void {
  const doc = root.ownerDocument
  const onSelectionChange = (): void => {
    const sel = doc.getSelection()
    if (!sel || sel.rangeCount === 0) return
    const range = sel.getRangeAt(0)
    if (!root.contains(range.commonAncestorContainer)) return
    onChange(range.collapsed || range.toString().trim() === '' ? null : range.cloneRange())
  }
  doc.addEventListener('selectionchange', onSelectionChange)
  return () => doc.removeEventListener('selectionchange', onSelectionChange)
}

function elementOf(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
}

function lineAttr(node: Node, root: HTMLElement, attr: string): number | null {
  const el = elementOf(node)?.closest(`[${attr}]`)
  if (!el || !root.contains(el)) return null
  const n = Number(el.getAttribute(attr))
  return Number.isInteger(n) && n > 0 ? n : null
}

export function sourceLinesOf(
  range: Range,
  root: HTMLElement,
): { startLine: number; endLine: number } | null {
  const startLine = lineAttr(range.startContainer, root, 'data-line-start')
  const endLine = lineAttr(range.endContainer, root, 'data-line-end')
  if (startLine === null || endLine === null) return null
  return { startLine: Math.min(startLine, endLine), endLine: Math.max(startLine, endLine) }
}
