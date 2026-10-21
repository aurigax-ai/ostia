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
