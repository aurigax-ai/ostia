import {
  BoundingBoxIcon,
  CaretLeftIcon,
  CaretRightIcon,
  PaperPlaneTiltIcon,
  XIcon,
} from '@phosphor-icons/react'
import {
  type CSSProperties,
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react'
import { useSelectionSend } from '@/components/agents/SelectionSend'
import { FindBar, findStatus } from '@/components/common/FindBar'
import { IconButton } from '@/components/common/IconButton'
import { fmt, useDict } from '@/lib/app/useDict'
import { useElementSize } from '@/lib/app/useElementSize'
import { trackSelection } from '@/lib/browser/domSelection'
import { fitWidthScale, type Size } from '@/lib/browser/regionSelect'
import { baseName } from '@/lib/files/fileTree'
import { loadPdfjs, openPdf, type PdfDocument, type PdfPage } from '@/lib/files/pdf'
import { useFileBytes, usePinchZoom, useRegionDrag, useSettled } from '@/lib/files/viewerHooks'
import { usePdfFind, usePdfSend } from './pdfViewerHooks'
import { useBytesProblem, ViewerMessage, type Zoom, ZoomControls } from './ViewerChrome'

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

function PdfToolbar({
  filePath,
  pageNumber,
  pageCount,
  goTo,
  scale,
  zoom,
  onZoom,
  regionMode,
  toggleRegionMode,
  hasRegion,
  clearRegion,
  sendLabel,
  canSend,
  onSend,
  onKeyDown,
}: {
  filePath: string
  pageNumber: number
  pageCount: number
  goTo: (n: number) => void
  scale: number
  zoom: Zoom
  onZoom: (zoom: Zoom) => void
  regionMode: boolean
  toggleRegionMode: () => void
  hasRegion: boolean
  clearRegion: () => void
  sendLabel: string
  canSend: boolean
  onSend: () => void
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void
}): JSX.Element {
  const d = useDict()
  return (
    <div className="viewer-toolbar" onKeyDown={onKeyDown}>
      <span className="viewer-title">{baseName(filePath)}</span>
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
      <ZoomControls scale={scale} zoom={zoom} onZoom={onZoom} />
      <IconButton
        size="bar"
        icon={BoundingBoxIcon}
        label={d.viewer.selectRegion}
        aria-pressed={regionMode}
        onClick={toggleRegionMode}
      />
      {hasRegion ? (
        <IconButton size="bar" icon={XIcon} label={d.viewer.clearRegion} onClick={clearRegion} />
      ) : null}
      <IconButton
        size="bar"
        icon={PaperPlaneTiltIcon}
        label={sendLabel}
        disabled={!canSend}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onSend}
      />
    </div>
  )
}

function PdfStage({
  stageRef,
  pageRef,
  canvasRef,
  textRef,
  message,
  pageStyle,
  hidden,
  regionMode,
  drag,
  region,
  scale,
  onRegionKeyDown,
}: {
  stageRef: RefObject<HTMLDivElement>
  pageRef: RefObject<HTMLDivElement>
  canvasRef: RefObject<HTMLCanvasElement>
  textRef: RefObject<HTMLDivElement>
  message: string | null
  pageStyle: CSSProperties
  hidden: boolean
  regionMode: boolean
  drag: ReturnType<typeof useRegionDrag>
  region: ReturnType<typeof useRegionDrag>['region']
  scale: number
  onRegionKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void
}): JSX.Element {
  const d = useDict()

  return (
    <div className="viewer-body">
      <div ref={stageRef} className="viewer-stage">
        {message ? <ViewerMessage>{message}</ViewerMessage> : null}
        <div
          ref={pageRef}
          className="pdf-page"
          style={hidden ? { ...pageStyle, display: 'none' } : pageStyle}
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
  )
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
  const { finding, setFinding, query, setQuery, active, setActive, matches, stepFind, onFindKey } =
    usePdfFind({ doc, filePath, pageNumber, setPageNumber, textRef, textVersion })

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

  const onRegionKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape' && regionMode) {
      e.stopPropagation()
      drag.clear()
      setRegionMode(false)
    }
  }

  const sendRef = usePdfSend({
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
    failedText: d.viewer.pdfFailed,
  })

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

  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: the viewer takes focus so its find key reaches it
    <div className="viewer-surface" tabIndex={0} onKeyDown={onFindKey}>
      {selectionSend.status}
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
      <PdfToolbar
        filePath={filePath}
        pageNumber={pageNumber}
        pageCount={pageCount}
        goTo={goTo}
        scale={scale}
        zoom={zoom}
        onZoom={setZoom}
        regionMode={regionMode}
        toggleRegionMode={toggleRegionMode}
        hasRegion={region !== null}
        clearRegion={drag.clear}
        sendLabel={sendLabel}
        canSend={page !== null}
        onSend={() => sendRef.current()}
        onKeyDown={onRegionKeyDown}
      />
      <PdfStage
        stageRef={stageRef}
        pageRef={pageRef}
        canvasRef={canvasRef}
        textRef={textRef}
        message={message}
        pageStyle={pageStyle}
        hidden={Boolean(message) || !page}
        regionMode={regionMode}
        drag={drag}
        region={region}
        scale={scale}
        onRegionKeyDown={onRegionKeyDown}
      />
      {selectionSend.panel}
    </div>
  )
}
