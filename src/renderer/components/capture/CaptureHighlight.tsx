import type { JSX } from 'react'
import { useCaptureHighlight } from '@/lib/capture/useCapture'
import { RegionCropBox } from './RegionCropOverlay'

export function CaptureHighlight({ paneId }: { paneId: string }): JSX.Element | null {
  const highlight = useCaptureHighlight(paneId)
  return highlight ? <RegionCropBox rect={highlight.rect} sized={highlight.sized} /> : null
}
