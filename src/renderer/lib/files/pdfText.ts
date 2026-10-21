import type { PdfDocument } from './pdf'

export const PDF_MAX_PAGES = 300

interface TextItemLike {
  str?: unknown
  hasEOL?: unknown
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
