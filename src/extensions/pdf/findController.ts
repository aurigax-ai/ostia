import type { FindOptions, Pill } from '@aurigax-ai/ostia-extension-sdk/pill'
import { clearFind, paintFind, textRanges } from './highlight'
import type { PageView } from './pageView'
import { type FindMatch, findMatches, firstMatchFrom, stepIndex } from './pdfFind'
import type { PdfDocument } from './pdfjs'

const BATCH = 16

export interface FindController {
  query: (query: string, options: FindOptions) => void
  step: (direction: 1 | -1) => void
  close: () => void
  rendered: (view: PageView) => void
}

interface FindDeps {
  doc: PdfDocument
  views: () => readonly PageView[]
  pill: () => Pill
  currentPage: () => number
  goTo: (page: number) => void
}

export function createFindController(deps: FindDeps): FindController {
  const texts: (string[] | undefined)[] = Array.from({ length: deps.doc.numPages })
  let query = ''
  let options: FindOptions = { matchCase: false, highlightAll: false }
  let matches: FindMatch[] = []
  let active = -1
  let extracting: Promise<void> | null = null
  let waitingFor: number | null = null

  const report = (): void => {
    deps.pill().find.setResult({ index: active + 1, total: matches.length })
  }

  const activeRange = (view: PageView): Range | null => {
    const match = matches[active]
    if (!match || match.page !== view.number) return null
    return textRanges(view.textElement, query, options.matchCase)[match.nth] ?? null
  }

  const paint = (): void => {
    if (!query || matches.length === 0) {
      clearFind()
      return
    }
    const rendered = deps.views().filter((view) => view.isRendered)
    const all = options.highlightAll
      ? rendered.flatMap((view) => textRanges(view.textElement, query, options.matchCase))
      : []
    const current = rendered.map(activeRange).find((range) => range !== null) ?? null
    paintFind(all, current)
  }

  const reveal = (): void => {
    const match = matches[active]
    if (!match) return
    const view = deps.views()[match.page - 1]
    if (view.isRendered) {
      paint()
      activeRange(view)?.startContainer.parentElement?.scrollIntoView({ block: 'center' })
    } else {
      waitingFor = match.page
      deps.goTo(match.page)
    }
  }

  const recompute = (): void => {
    const previous = matches[active]
    matches = findMatches(texts, query, options.matchCase)
    if (matches.length === 0) active = -1
    else if (active < 0) active = firstMatchFrom(matches, deps.currentPage())
    else if (previous) {
      const kept = matches.findIndex((m) => m.page === previous.page && m.nth === previous.nth)
      active = kept >= 0 ? kept : firstMatchFrom(matches, previous.page)
    }
    report()
  }

  async function extract(): Promise<void> {
    for (let index = 0; index < texts.length; index++) {
      if (texts[index]) continue
      const page = await deps.doc.getPage(index + 1)
      const content = await page.getTextContent()
      texts[index] = content.items.map((item) => ('str' in item ? item.str : ''))
      page.cleanup()
      if (index % BATCH === BATCH - 1 && query) {
        const hadNone = active < 0
        recompute()
        if (hadNone && active >= 0) reveal()
      }
    }
    if (query) {
      const hadNone = active < 0
      recompute()
      if (hadNone && active >= 0) reveal()
    }
  }

  return {
    query: (next, nextOptions) => {
      query = next
      options = nextOptions
      active = -1
      if (!query) {
        matches = []
        clearFind()
        report()
        return
      }
      recompute()
      if (active >= 0) reveal()
      else paint()
      extracting ??= extract().catch(() => undefined)
    },
    step: (direction) => {
      active = stepIndex(active, matches.length, direction)
      report()
      reveal()
    },
    close: () => {
      query = ''
      matches = []
      active = -1
      waitingFor = null
      clearFind()
    },
    rendered: (view) => {
      if (!query) return
      paint()
      if (waitingFor === view.number) {
        waitingFor = null
        activeRange(view)?.startContainer.parentElement?.scrollIntoView({ block: 'center' })
      }
    },
  }
}
