import {
  type Dispatch,
  type KeyboardEvent,
  type RefObject,
  type SetStateAction,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { useSelectionSend } from '@/components/agents/SelectionSend'
import { registerSelectionSender } from '@/lib/agents/selectionSenders'
import { cropToPng } from '@/lib/browser/cropImage'
import { pixelRect } from '@/lib/browser/regionSelect'
import { clearFind, findRanges, paintFind } from '@/lib/files/domFind'
import type { PdfDocument, PdfPage } from '@/lib/files/pdf'
import { itemTexts, pageItems, pdfMatches } from '@/lib/files/pdfText'
import type { useRegionDrag } from '@/lib/files/viewerHooks'
import { findStep, matchChord } from '@/lib/keyboard/chords'
import { isMac } from '@/platform'
import { usePdfFindStore } from '@/stores/files/pdfFindStore'

function usePageTexts(doc: PdfDocument | null, wanted: boolean): string[][] | null {
  const [texts, setTexts] = useState<string[][] | null>(null)
  useEffect(() => {
    setTexts(null)
    if (!doc || !wanted) return
    let alive = true
    pageItems(doc, doc.numPages).then(
      (pages) => {
        if (alive) setTexts(pages.map(itemTexts))
      },
      () => undefined,
    )
    return () => {
      alive = false
    }
  }, [doc, wanted])
  return texts
}

function isFindKey(e: KeyboardEvent<HTMLElement>): boolean {
  if (matchChord(e, isMac) === 'find') return true
  return (isMac ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f'
}

export function usePdfFind({
  doc,
  filePath,
  pageNumber,
  setPageNumber,
  textRef,
  textVersion,
}: {
  doc: PdfDocument | null
  filePath: string
  pageNumber: number
  setPageNumber: Dispatch<SetStateAction<number>>
  textRef: RefObject<HTMLDivElement>
  textVersion: number
}) {
  const [finding, setFinding] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [wantPage, setWantPage] = useState<number | null>(null)
  const pageTexts = usePageTexts(doc, finding)
  const matches = useMemo(() => (pageTexts ? pdfMatches(pageTexts, query) : []), [pageTexts, query])
  const current = matches[active] ?? null

  useEffect(() => {
    const request = usePdfFindStore.getState().take(filePath)
    if (!request) return
    setFinding(true)
    setQuery(request.query)
    setWantPage(request.page)
    setPageNumber(request.page)
  }, [filePath, setPageNumber])

  useEffect(() => {
    if (wantPage === null || !pageTexts) return
    const first = matches.findIndex((m) => m.page === wantPage)
    setActive(first >= 0 ? first : 0)
    setWantPage(null)
  }, [wantPage, pageTexts, matches])

  useEffect(() => {
    if (current && current.page !== pageNumber) setPageNumber(current.page)
  }, [current, pageNumber, setPageNumber])

  useEffect(() => {
    const textEl = textRef.current
    if (!finding || !textEl || textVersion === 0) {
      clearFind()
      return
    }
    const ranges = findRanges(textEl, query)
    const nth = current && current.page === pageNumber ? current.nth : -1
    paintFind(ranges, nth)
    ranges[nth]?.startContainer.parentElement?.scrollIntoView({ block: 'center' })
  }, [finding, query, current, pageNumber, textVersion, textRef])

  useEffect(() => clearFind, [])

  const stepFind = (by: number): void => {
    if (matches.length > 0) setActive((i) => (i + by + matches.length) % matches.length)
  }

  const onFindKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const by = findStep(matchChord(e, isMac))
    if (by === null && !isFindKey(e)) return
    e.preventDefault()
    if (by !== null && finding) stepFind(by)
    else setFinding(true)
  }

  return { finding, setFinding, query, setQuery, active, setActive, matches, stepFind, onFindKey }
}

export function usePdfSend({
  paneId,
  filePath,
  canvasRef,
  page,
  base,
  pageNumber,
  regionMode,
  selectedText,
  drag,
  selectionSend,
  failedText,
}: {
  paneId: string
  filePath: string
  canvasRef: RefObject<HTMLCanvasElement>
  page: PdfPage | null
  base: { width: number; height: number } | null
  pageNumber: number
  regionMode: boolean
  selectedText: string | null
  drag: ReturnType<typeof useRegionDrag>
  selectionSend: ReturnType<typeof useSelectionSend>
  failedText: string
}) {
  const sendRef = useRef<() => void>(() => {})
  sendRef.current = () => {
    const canvas = canvasRef.current
    if (!page || !base || !canvas) return
    if (!regionMode && selectedText) {
      selectionSend.open({
        kind: 'pdf-text',
        file: filePath,
        firstPage: pageNumber,
        lastPage: pageNumber,
        text: selectedText,
      })
      return
    }
    const region = regionMode ? drag.region : null
    const factor = canvas.width / base.width
    const bounds = { width: canvas.width, height: canvas.height }
    const rect = region ? pixelRect(region, factor, bounds) : { x: 0, y: 0, ...bounds }
    cropToPng(canvas, rect).then(
      (png) =>
        selectionSend.open(
          {
            kind: 'pdf-region',
            file: filePath,
            page: pageNumber,
            pageWidth: Math.round(base.width * 100) / 100,
            pageHeight: Math.round(base.height * 100) / 100,
            region,
          },
          png,
        ),
      () => selectionSend.notify(failedText),
    )
  }

  useEffect(() => registerSelectionSender(paneId, () => sendRef.current()), [paneId])

  return sendRef
}
