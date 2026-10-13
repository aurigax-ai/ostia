import type { PdfDocument } from './pdf'

export const PDF_MAX_PAGES = 300

interface TextItemLike {
  str?: unknown
  hasEOL?: unknown
}

export function itemTexts(items: readonly TextItemLike[]): string[] {
  return items.map((item) => (typeof item.str === 'string' ? item.str : ''))
}

export function itemLines(items: readonly TextItemLike[]): string[] {
  const lines: string[] = []
  let line = ''
  for (const item of items) {
    if (typeof item.str === 'string') line += item.str
    if (item.hasEOL === true) {
      lines.push(line)
      line = ''
    }
  }
  if (line) lines.push(line)
  return lines.map((l) => l.trim()).filter(Boolean)
}

export async function pageItems(doc: PdfDocument, maxPages: number): Promise<TextItemLike[][]> {
  const pages: TextItemLike[][] = []
  const count = Math.min(doc.numPages, maxPages)
  for (let n = 1; n <= count; n++) {
    const page = await doc.getPage(n)
    const content = await page.getTextContent()
    pages.push(content.items as TextItemLike[])
  }
  return pages
}

export function countIn(text: string, query: string): number {
  if (!query) return 0
  const hay = text.toLocaleLowerCase()
  const needle = query.toLocaleLowerCase()
  let count = 0
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) count++
  return count
}

export interface PdfMatch {
  page: number
  nth: number
}

export function pdfMatches(pages: readonly string[][], query: string): PdfMatch[] {
  const matches: PdfMatch[] = []
  pages.forEach((items, i) => {
    const total = items.reduce((n, text) => n + countIn(text, query), 0)
    for (let nth = 0; nth < total; nth++) matches.push({ page: i + 1, nth })
  })
  return matches
}
