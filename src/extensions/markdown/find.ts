const FIND_HIGHLIGHT = 'ostia-find'
const FIND_ACTIVE_HIGHLIGHT = 'ostia-find-active'
const SHOW_TEXT = 4

interface FindOptions {
  matchCase: boolean
  highlightAll: boolean
}

export interface FindResult {
  index: number
  total: number
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function findRanges(root: Node, query: string, matchCase: boolean): Range[] {
  if (!query) return []
  const doc = root.ownerDocument
  if (!doc) return []
  const pattern = new RegExp(escapeRegExp(query), matchCase ? 'gu' : 'giu')
  const ranges: Range[] = []
  const walker = doc.createTreeWalker(root, SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    for (const match of (node.textContent ?? '').matchAll(pattern)) {
      const range = doc.createRange()
      range.setStart(node, match.index)
      range.setEnd(node, match.index + match[0].length)
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

function paintFind(ranges: Range[], active: number, all: boolean): void {
  const api = registry()
  if (!api) return
  if (all) api.highlights.set(FIND_HIGHLIGHT, new api.Highlight(...ranges))
  else api.highlights.delete(FIND_HIGHLIGHT)
  const current = ranges[active]
  if (current) api.highlights.set(FIND_ACTIVE_HIGHLIGHT, new api.Highlight(current))
  else api.highlights.delete(FIND_ACTIVE_HIGHLIGHT)
}

export function clearFind(): void {
  const api = registry()
  api?.highlights.delete(FIND_HIGHLIGHT)
  api?.highlights.delete(FIND_ACTIVE_HIGHLIGHT)
}

export interface Finder {
  search: (query: string, options: FindOptions) => void
  step: (direction: 1 | -1) => void
  refresh: () => void
  close: () => void
}

export function createFinder(root: HTMLElement, report: (result: FindResult) => void): Finder {
  let query = ''
  let options: FindOptions = { matchCase: false, highlightAll: false }
  let ranges: Range[] = []
  let active = 0

  const apply = (reveal: boolean): void => {
    if (ranges.length === 0) clearFind()
    else paintFind(ranges, active, options.highlightAll)
    report({ index: ranges.length === 0 ? 0 : active + 1, total: ranges.length })
    if (reveal) ranges[active]?.startContainer.parentElement?.scrollIntoView({ block: 'center' })
  }
  const collect = (): void => {
    ranges = findRanges(root, query, options.matchCase)
    active = Math.min(active, Math.max(ranges.length - 1, 0))
  }

  return {
    search: (next, nextOptions) => {
      query = next
      options = nextOptions
      active = 0
      collect()
      apply(true)
    },
    step: (direction) => {
      if (ranges.length === 0) return
      active = (active + direction + ranges.length) % ranges.length
      apply(true)
    },
    refresh: () => {
      if (query === '') return
      collect()
      apply(false)
    },
    close: () => {
      query = ''
      ranges = []
      active = 0
      clearFind()
    },
  }
}
