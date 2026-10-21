import { matchOffsets } from './pdfFind'

const FIND_HIGHLIGHT = 'ostia-find'
const FIND_ACTIVE_HIGHLIGHT = 'ostia-find-active'

export function textRanges(root: Node, query: string, matchCase: boolean): Range[] {
  const ranges: Range[] = []
  if (!query) return ranges
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    for (const at of matchOffsets(node.textContent ?? '', query, matchCase)) {
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + query.length)
      ranges.push(range)
    }
  }
  return ranges
}

export function paintFind(all: Range[], active: Range | null): void {
  CSS.highlights.set(FIND_HIGHLIGHT, new Highlight(...all))
  if (active) CSS.highlights.set(FIND_ACTIVE_HIGHLIGHT, new Highlight(active))
  else CSS.highlights.delete(FIND_ACTIVE_HIGHLIGHT)
}

export function clearFind(): void {
  CSS.highlights.delete(FIND_HIGHLIGHT)
  CSS.highlights.delete(FIND_ACTIVE_HIGHLIGHT)
}
