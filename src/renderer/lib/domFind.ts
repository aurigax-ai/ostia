export const FIND_HIGHLIGHT = 'ostia-find'
export const FIND_ACTIVE_HIGHLIGHT = 'ostia-find-active'

export function findRanges(root: Node, query: string): Range[] {
  if (!query) return []
  const needle = query.toLocaleLowerCase()
  const ranges: Range[] = []
  const walker = root.ownerDocument?.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  if (!walker) return ranges
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.textContent ?? '').toLocaleLowerCase()
    for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) {
      const range = root.ownerDocument?.createRange()
      if (!range) continue
      range.setStart(node, at)
      range.setEnd(node, at + needle.length)
      ranges.push(range)
    }
  }
  return ranges
}

interface HighlightRegistry {
  set: (name: string, highlight: unknown) => void
  delete: (name: string) => void
}

type HighlightConstructor = new (...ranges: Range[]) => unknown

function registry(): { highlights: HighlightRegistry; Highlight: HighlightConstructor } | null {
  const css = globalThis.CSS as { highlights?: HighlightRegistry } | undefined
  const Highlight = (globalThis as { Highlight?: HighlightConstructor }).Highlight
  return css?.highlights && Highlight ? { highlights: css.highlights, Highlight } : null
}

export function paintFind(ranges: Range[], active: number): void {
  const api = registry()
  if (!api) return
  api.highlights.set(FIND_HIGHLIGHT, new api.Highlight(...ranges))
  const current = ranges[active]
  if (current) api.highlights.set(FIND_ACTIVE_HIGHLIGHT, new api.Highlight(current))
  else api.highlights.delete(FIND_ACTIVE_HIGHLIGHT)
}

export function clearFind(): void {
  const api = registry()
  api?.highlights.delete(FIND_HIGHLIGHT)
  api?.highlights.delete(FIND_ACTIVE_HIGHLIGHT)
}
