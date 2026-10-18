import { escapeRegExp } from 'es-toolkit'

export interface HighlightPart {
  text: string
  at: number
  match: boolean
}

let cachedPattern: { query: string; pattern: RegExp | null } | null = null

function queryPattern(query: string): RegExp | null {
  if (cachedPattern?.query === query) return cachedPattern.pattern
  const q = query.trim()
  const pattern = q ? new RegExp(escapeRegExp(q), 'gi') : null
  cachedPattern = { query, pattern }
  return pattern
}

export function matchesQuery(
  texts: readonly (string | null | undefined)[],
  query: string,
): boolean {
  const pattern = queryPattern(query)
  if (!pattern) return false
  return texts.some((text) => {
    if (!text) return false
    pattern.lastIndex = 0
    return pattern.test(text)
  })
}

export function highlightParts(text: string, query: string): HighlightPart[] {
  const pattern = queryPattern(query)
  if (!pattern || !text) return text ? [{ text, at: 0, match: false }] : []
  pattern.lastIndex = 0
  const parts: HighlightPart[] = []
  let cursor = 0
  for (const found of text.matchAll(pattern)) {
    const start = found.index
    if (start > cursor) parts.push({ text: text.slice(cursor, start), at: cursor, match: false })
    parts.push({ text: found[0], at: start, match: true })
    cursor = start + found[0].length
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), at: cursor, match: false })
  return parts
}

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [role="switch"], [role="combobox"], [tabindex]:not([tabindex="-1"])'

export function firstMatchControl(root: ParentNode | null): HTMLElement | null {
  if (!root) return null
  for (const hit of root.querySelectorAll<HTMLElement>('[data-search-hit]')) {
    if (hit.closest('[hidden]')) continue
    const control = hit.matches(FOCUSABLE) ? hit : hit.querySelector<HTMLElement>(FOCUSABLE)
    if (control) return control
  }
  return null
}
