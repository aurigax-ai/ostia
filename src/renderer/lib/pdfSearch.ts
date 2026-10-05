import type { SearchPdf } from '@shared/search'
import { childPath } from './fileTree'
import { openPdf } from './pdf'
import { PDF_MAX_PAGES, itemLines, pageItems } from './pdfText'
import type { LineMatcher } from './textMatch'

export const PDF_SEARCH_MAX_BYTES = 25 * 1024 * 1024
export const PDF_MATCH_LIMIT = 200
const CACHE_MAX = 64
const PREVIEW_CHARS = 240
const PREVIEW_LEAD = 40

export interface PdfLineMatch {
  page: number
  text: string
  ranges: [number, number][]
  query: string
}

export interface PdfFileMatches {
  path: string
  matches: PdfLineMatch[]
}

export interface PdfSearchResults {
  files: PdfFileMatches[]
  skipped: number
}

const cache = new Map<string, Promise<string[][] | null>>()

async function extract(path: string): Promise<string[][] | null> {
  const bytes = await window.ostia.fs.readBinary(path)
  if (!bytes.ok) return null
  const doc = await openPdf(bytes.data)
  try {
    const pages = await pageItems(doc, PDF_MAX_PAGES)
    return pages.map(itemLines)
  } finally {
    void doc.loadingTask.destroy()
  }
}

function pdfLines(path: string, pdf: SearchPdf): Promise<string[][] | null> {
  const key = `${path}\0${pdf.size}\0${pdf.mtimeMs}`
  const cached = cache.get(key)
  if (cached) return cached
  const lines = extract(path).catch(() => null)
  cache.set(key, lines)
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  return lines
}

export function clipLine(
  line: string,
  ranges: [number, number][],
): { text: string; ranges: [number, number][] } {
  const first = ranges[0]?.[0] ?? 0
  const start = line.length <= PREVIEW_CHARS ? 0 : Math.max(0, first - PREVIEW_LEAD)
  const end = start + PREVIEW_CHARS
  const shifted: [number, number][] = []
  for (const [from, to] of ranges) {
    if (from >= end) break
    shifted.push([from - start, Math.min(to, end) - start])
  }
  return { text: line.slice(start, end), ranges: shifted }
}

export async function searchPdfs(
  root: string,
  pdfs: readonly SearchPdf[],
  matcher: LineMatcher,
): Promise<PdfSearchResults> {
  const files: PdfFileMatches[] = []
  let skipped = 0
  let total = 0
  for (const pdf of pdfs) {
    if (total >= PDF_MATCH_LIMIT) break
    if (pdf.size > PDF_SEARCH_MAX_BYTES) {
      skipped++
      continue
    }
    const pages = await pdfLines(childPath(root, pdf.path), pdf)
    if (!pages) {
      skipped++
      continue
    }
    const matches: PdfLineMatch[] = []
    pages.forEach((lines, i) => {
      for (const line of lines) {
        if (total >= PDF_MATCH_LIMIT) return
        const ranges = matcher(line)
        if (ranges.length === 0) continue
        const [from, to] = ranges[0]
        matches.push({ page: i + 1, ...clipLine(line, ranges), query: line.slice(from, to) })
        total++
      }
    })
    if (matches.length > 0) files.push({ path: pdf.path, matches })
  }
  return { files, skipped }
}
