import { PaperPlaneTiltIcon, XIcon } from '@phosphor-icons/react'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { useDict } from '../i18n/useDict'
import { cropToPng } from '../lib/cropImage'
import { imageMimeType } from '../lib/fileKinds'
import { type Size, fitScale } from '../lib/regionSelect'
import { registerSelectionSender } from '../lib/selectionSenders'
import { useElementSize, useFileBytes, usePinchZoom, useRegionDrag } from '../lib/viewerHooks'
import { IconButton } from './IconButton'
import { useSelectionSend } from './SelectionSend'
import { ViewerMessage, type Zoom, ZoomControls, useBytesProblem } from './ViewerChrome'

const STAGE_PADDING = 16
const NO_SIZE: Size = { width: 0, height: 0 }

export function ImageViewer({
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
  const [url, setUrl] = useState<string | null>(null)
  const [natural, setNatural] = useState<Size | null>(null)
  const [broken, setBroken] = useState(false)
  const [zoom, setZoom] = useState<Zoom>('fit')
  const stageRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const stage = useElementSize(stageRef)
  const selectionSend = useSelectionSend(workspaceId, paneId)

  useEffect(() => {
    if ('status' in bytes || !bytes.ok) return
    const blob = new Blob([bytes.data.slice()], { type: imageMimeType(filePath) ?? '' })
    const next = URL.createObjectURL(blob)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [bytes, filePath])

  const scale = zoom === 'fit' ? (natural ? fitScale(natural, stage, STAGE_PADDING) : 1) : zoom
  const drag = useRegionDrag({ scale, bounds: natural ?? NO_SIZE, enabled: natural !== null })
  usePinchZoom({ stageRef, contentRef: canvasRef, scale, onZoom: setZoom })

  const sendRef = useRef<() => void>(() => {})
  sendRef.current = () => {
    const img = imgRef.current
    if (!img || !natural) return
    const region = drag.region
    const rect = region ?? { x: 0, y: 0, width: natural.width, height: natural.height }
    cropToPng(img, rect).then(
      (png) =>
        selectionSend.open(
          {
            kind: 'image',
            file: filePath,
            imageWidth: natural.width,
            imageHeight: natural.height,
            region,
          },
          png,
        ),
      () => selectionSend.notify(d.viewer.imageFailed),
    )
  }

  useEffect(() => registerSelectionSender(paneId, () => sendRef.current()), [paneId])

  const onLoad = (): void => {
    const img = imgRef.current
    if (!img) return
    const width = img.naturalWidth || img.width
    const height = img.naturalHeight || img.height
    if (width > 0 && height > 0) setNatural({ width, height })
    else setBroken(true)
  }

  const onCanvasKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape' && drag.region) {
      e.stopPropagation()
      drag.clear()
    }
  }

  const message = problem ?? (broken ? d.viewer.imageFailed : null)
  const region = drag.region

  return (
    <div className="viewer-surface">
      <div className="viewer-toolbar">
        <span className="viewer-title">{filePath.split('/').pop()}</span>
        {natural ? (
          <span className="viewer-meta">
            {natural.width} × {natural.height}
          </span>
        ) : null}
        <span className="flex-1" />
        <ZoomControls scale={scale} zoom={zoom} onZoom={setZoom} />
        {region ? (
          <IconButton size="bar" icon={XIcon} label={d.viewer.clearRegion} onClick={drag.clear} />
        ) : null}
        <IconButton
          size="bar"
          icon={PaperPlaneTiltIcon}
          label={region ? d.viewer.sendRegion : d.viewer.sendImage}
          disabled={!natural}
          onClick={() => sendRef.current()}
        />
      </div>
      <div ref={stageRef} className="viewer-stage">
        {message ? (
          <ViewerMessage>{message}</ViewerMessage>
        ) : url ? (
          <div
            ref={canvasRef}
            className={drag.enabled ? 'viewer-canvas region-select' : 'viewer-canvas'}
            tabIndex={-1}
            onKeyDown={onCanvasKeyDown}
            style={
              natural
                ? { width: natural.width * scale, height: natural.height * scale }
                : { visibility: 'hidden' }
            }
            {...drag.handlers}
          >
            <img
              ref={imgRef}
              src={url}
              alt={filePath.split('/').pop()}
              draggable={false}
              onLoad={onLoad}
              onError={() => setBroken(true)}
            />
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
      {selectionSend.panel}
      {selectionSend.status}
    </div>
  )
}
