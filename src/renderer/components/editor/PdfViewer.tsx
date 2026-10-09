import { useSelectionSend } from '@/components/agents/SelectionSend'
import { FindBar, findStatus } from '@/components/common/FindBar'
import { IconButton } from '@/components/common/IconButton'
import { fmt, useDict } from '@/i18n/useDict'
import { registerSelectionSender } from '@/lib/agents/selectionSenders'
import { cropToPng } from '@/lib/browser/cropImage'
import { trackSelection } from '@/lib/browser/domSelection'
import { type Size, fitWidthScale, pixelRect } from '@/lib/browser/regionSelect'
import { clearFind, findRanges, paintFind } from '@/lib/files/domFind'
import { type PdfDocument, type PdfPage, loadPdfjs, openPdf } from '@/lib/files/pdf'
import { itemTexts, pageItems, pdfMatches } from '@/lib/files/pdfText'
import {
  useElementSize,
  useFileBytes,
  usePinchZoom,
  useRegionDrag,
  useSettled,
} from '@/lib/files/viewerHooks'
import { findStep, matchChord } from '@/lib/keys/chords'
import { isMac } from '@/platform'
import { usePdfFindStore } from '@/stores/files/pdfFindStore'
import {
  BoundingBoxIcon,
  CaretLeftIcon,
  CaretRightIcon,
  PaperPlaneTiltIcon,
  XIcon,
} from '@phosphor-icons/react'
import { type CSSProperties, type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import { ViewerMessage, type Zoom, ZoomControls, useBytesProblem } from './ViewerChrome'

const STAGE_PADDING = 16
const RENDER_SETTLE_MS = 120
const NO_SIZE: Size = { width: 0, height: 0 }

function usePdfDocument(bytes: ReturnType<typeof useFileBytes>): {
  doc: PdfDocument | null
  failed: boolean
} {
  const [doc, setDoc] = useState<PdfDocument | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    setDoc(null)
    setFailed(false)
    if ('status' in bytes || !bytes.ok) return
    let alive = true
    let opened: PdfDocument | null = null
    openPdf(bytes.data.slice()).then(
      (d) => {
        opened = d
        if (alive) setDoc(d)
        else void d.loadingTask.destroy()
      },
      () => {
        if (alive) setFailed(true)
      },
    )
    return () => {
      alive = false
      void opened?.loadingTask.destroy()
    }
  }, [bytes])
  return { doc, failed }
}

function usePdfPage(doc: PdfDocument | null, pageNumber: number): PdfPage | null {
  const [page, setPage] = useState<PdfPage | null>(null)
  useEffect(() => {
    setPage(null)
    if (!doc) return
    let alive = true
    doc.getPage(pageNumber).then(
      (p) => {
        if (alive) setPage(p)
      },
      () => undefined,
    )
    return () => {
      alive = false
    }
  }, [doc, pageNumber])
  return page
}

function usePageRender(
  page: PdfPage | null,
  scale: number,
  canvasRef: React.RefObject<HTMLCanvasElement>,
  textRef: React.RefObject<HTMLDivElement>,
): number {
  const [textVersion, setTextVersion] = useState(0)
  useEffect(() => {
    const canvas = canvasRef.current
    const textEl = textRef.current
    if (!page || !canvas || !textEl) return
    const viewport = page.getViewport({ scale })
    const ratio = window.devicePixelRatio || 1
    canvas.width = Math.max(1, Math.floor(viewport.width * ratio))
    canvas.height = Math.max(1, Math.floor(viewport.height * ratio))
    const task = page.render({
      canvas,
      viewport,
      ...(ratio !== 1 ? { transform: [ratio, 0, 0, ratio, 0, 0] } : {}),
    })
    task.promise.catch(() => undefined)
    let cancelled = false
    let cancelText: (() => void) | null = null
    textEl.replaceChildren()
    loadPdfjs()
      .then((pdfjs) => {
        if (cancelled) return
        const layer = new pdfjs.TextLayer({
          textContentSource: page.streamTextContent(),
          container: textEl,
          viewport,
        })
        cancelText = () => layer.cancel()
        return layer.render().then(() => {
          if (!cancelled) setTextVersion((v) => v + 1)
        })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
      task.cancel()
      cancelText?.()
    }
  }, [page, scale, canvasRef, textRef])
  return textVersion
}

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

export function PdfViewer({
  workspaceId,
  paneId,
  filePath,
}: {
  workspaceId: string
  paneId: string
  filePath: string
}): JSX.Element {
  const d = useDict()
  const bytes = useFileBytes(filePath)
  const problem = useBytesProblem(bytes)
  const { doc, failed } = usePdfDocument(bytes)
  const [pageNumber, setPageNumber] = useState(1)
  const page = usePdfPage(doc, pageNumber)
  const [zoom, setZoom] = useState<Zoom>('fit')
  const [regionMode, setRegionMode] = useState(false)
  const [selectedText, setSelectedText] = useState<string | null>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textRef = useRef<HTMLDivElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  const stage = useElementSize(stageRef)
  const selectionSend = useSelectionSend(workspaceId, paneId)

  const base = page?.getViewport({ scale: 1 }) ?? null
  const pageSize = base ? { width: base.width, height: base.height } : NO_SIZE
  const scale = zoom === 'fit' ? (base ? fitWidthScale(pageSize, stage, STAGE_PADDING) : 1) : zoom
  const drag = useRegionDrag({ scale, bounds: pageSize, enabled: regionMode && base !== null })
  const pageCount = doc?.numPages ?? 0

  usePinchZoom({ stageRef, contentRef: pageRef, scale, onZoom: setZoom })
  const renderScale = useSettled(base ? scale : null, RENDER_SETTLE_MS)

  const textVersion = usePageRender(page, renderScale ?? scale, canvasRef, textRef)
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
  }, [filePath])

  useEffect(() => {
    if (wantPage === null || !pageTexts) return
    const first = matches.findIndex((m) => m.page === wantPage)
    setActive(first >= 0 ? first : 0)
    setWantPage(null)
  }, [wantPage, pageTexts, matches])

  useEffect(() => {
    if (current && current.page !== pageNumber) setPageNumber(current.page)
  }, [current, pageNumber])

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
  }, [finding, query, current, pageNumber, textVersion])

  useEffect(() => clearFind, [])

  useEffect(() => {
    const textEl = textRef.current
    if (!textEl) return
    return trackSelection(textEl, (range) => setSelectedText(range ? range.toString() : null))
  }, [])

  const goTo = (n: number): void => {
    if (n < 1 || n > pageCount) return
    setPageNumber(n)
    setSelectedText(null)
    drag.clear()
  }

  const toggleRegionMode = (): void => {
    drag.clear()
    setRegionMode((on) => !on)
  }

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
      () => selectionSend.notify(d.viewer.pdfFailed),
    )
  }

  useEffect(() => registerSelectionSender(paneId, () => sendRef.current()), [paneId])

  const onRegionKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape' && drag.region) {
      e.stopPropagation()
      drag.clear()
    }
  }

  const message = problem ?? (failed ? d.viewer.pdfFailed : null)
  const region = regionMode ? drag.region : null
  const sendLabel = region
    ? d.viewer.sendRegion
    : !regionMode && selectedText
      ? d.viewer.sendPdfSelection
      : d.viewer.sendPage
  const pageStyle = {
    width: pageSize.width * scale,
    height: pageSize.height * scale,
    '--total-scale-factor': scale,
    '--scale-round-x': '1px',
    '--scale-round-y': '1px',
  } as CSSProperties

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

  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: the viewer takes focus so its find key reaches it
    <div className="viewer-surface" tabIndex={0} onKeyDown={onFindKey}>
      {finding ? (
        <FindBar
          className="pdf-find"
          label={d.find.pdfLabel}
          query={query}
          status={findStatus(query, matches.length, active, d.find.noResults)}
          onQuery={(q) => {
            setQuery(q)
            setActive(0)
          }}
          onStep={stepFind}
          onClose={() => {
            setFinding(false)
            setQuery('')
          }}
        />
      ) : null}
      <div className="viewer-toolbar">
        <span className="viewer-title">{filePath.split('/').pop()}</span>
        <span className="flex-1" />
        <IconButton
          size="bar"
          icon={CaretLeftIcon}
          label={d.viewer.previousPage}
          disabled={pageNumber <= 1}
          onClick={() => goTo(pageNumber - 1)}
        />
        <span className="viewer-meta">
          {fmt(d.viewer.pageOf, { page: pageCount ? pageNumber : 0, pages: pageCount })}
        </span>
        <IconButton
          size="bar"
          icon={CaretRightIcon}
          label={d.viewer.nextPage}
          disabled={pageNumber >= pageCount}
          onClick={() => goTo(pageNumber + 1)}
        />
        <ZoomControls scale={scale} zoom={zoom} onZoom={setZoom} />
        <IconButton
          size="bar"
          icon={BoundingBoxIcon}
          label={d.viewer.selectRegion}
          aria-pressed={regionMode}
          onClick={toggleRegionMode}
        />
        {region ? (
          <IconButton size="bar" icon={XIcon} label={d.viewer.clearRegion} onClick={drag.clear} />
        ) : null}
        <IconButton
          size="bar"
          icon={PaperPlaneTiltIcon}
          label={sendLabel}
          disabled={!page}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => sendRef.current()}
        />
      </div>
      <div className="viewer-body">
        <div ref={stageRef} className="viewer-stage">
          {message ? <ViewerMessage>{message}</ViewerMessage> : null}
          <div
            ref={pageRef}
            className="pdf-page"
            style={message || !page ? { ...pageStyle, display: 'none' } : pageStyle}
          >
            <canvas ref={canvasRef} className="pdf-canvas" />
            <div ref={textRef} className="pdf-text" data-region-mode={regionMode || undefined} />
            {regionMode ? (
              <div
                className={drag.enabled ? 'pdf-region-layer region-select' : 'pdf-region-layer'}
                tabIndex={-1}
                onKeyDown={onRegionKeyDown}
                {...drag.handlers}
              >
                {region ? (
                  <div
                    className="viewer-region"
                    style={{
                      left: region.x * scale,
                      top: region.y * scale,
                      width: region.width * scale,
                      height: region.height * scale,
                    }}
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
        {regionMode && !region ? (
          <output className="viewer-hint">{d.viewer.regionHint}</output>
        ) : null}
      </div>
      {selectionSend.panel}
      {selectionSend.status}
    </div>
  )
}
