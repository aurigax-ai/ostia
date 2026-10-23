import { useEffect, useRef } from 'react'
import { StatusLine } from '@/components/common/StatusLine'
import { closeCapture, setCaptureStatus } from '@/lib/capture/captureSession'
import { useCaptureStatus, useOpenCapture } from '@/lib/capture/useCapture'
import { CaptureBar } from './CaptureBar'
import { useCaptureDismissal } from './useCaptureDismissal'

interface CaptureLayerProps {
  workspaceId: string
  paneId: string
  visible?: boolean
}

export function CaptureLayer({
  workspaceId,
  paneId,
  visible = true,
}: CaptureLayerProps): JSX.Element {
  const capture = useOpenCapture(paneId)
  const status = useCaptureStatus(paneId)
  const rootRef = useRef<HTMLDivElement>(null)
  useCaptureDismissal(paneId, rootRef, capture !== null)

  const isOpen = capture !== null
  useEffect(() => {
    if (!visible && isOpen) closeCapture(paneId, 'hidden')
  }, [paneId, visible, isOpen])

  useEffect(() => () => closeCapture(paneId, 'source-gone'), [paneId])

  return (
    <div ref={rootRef} className="contents">
      {status ? (
        <div className="absolute inset-x-0 top-0 z-20">
          <StatusLine onDismiss={() => setCaptureStatus(paneId, null)}>{status}</StatusLine>
        </div>
      ) : null}
      {capture ? (
        <CaptureBar key={capture.key} workspaceId={workspaceId} paneId={paneId} capture={capture} />
      ) : null}
    </div>
  )
}
