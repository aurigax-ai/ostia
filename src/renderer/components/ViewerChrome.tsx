import {
  ArrowsInIcon,
  MagnifyingGlassMinusIcon,
  MagnifyingGlassPlusIcon,
} from '@phosphor-icons/react'
import type { ReactNode } from 'react'
import { fmt, useDict } from '../i18n/useDict'
import { stepZoom, zoomPercent } from '../lib/regionSelect'
import type { FileBytes } from '../lib/viewerHooks'
import { IconButton } from './IconButton'

export type Zoom = number | 'fit'

export function ZoomControls({
  scale,
  zoom,
  onZoom,
}: {
  scale: number
  zoom: Zoom
  onZoom: (zoom: Zoom) => void
}): JSX.Element {
  const d = useDict()
  return (
    <>
      <IconButton
        size="bar"
        icon={MagnifyingGlassMinusIcon}
        label={d.viewer.zoomOut}
        onClick={() => onZoom(stepZoom(scale, -1))}
      />
      <span className="viewer-zoom" aria-live="polite">
        {fmt(d.viewer.zoomLevel, { percent: zoomPercent(scale) })}
      </span>
      <IconButton
        size="bar"
        icon={MagnifyingGlassPlusIcon}
        label={d.viewer.zoomIn}
        onClick={() => onZoom(stepZoom(scale, 1))}
      />
      <IconButton
        size="bar"
        icon={ArrowsInIcon}
        label={d.viewer.fit}
        aria-pressed={zoom === 'fit'}
        onClick={() => onZoom('fit')}
      />
    </>
  )
}

export function ViewerMessage({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="viewer-message">
      <span className="ghost">{children}</span>
    </div>
  )
}

const MB = 1024 * 1024

export function useBytesProblem(bytes: FileBytes): string | null {
  const d = useDict()
  if ('status' in bytes) return d.viewer.loading
  if (bytes.ok) return null
  if (bytes.error === 'too-large') {
    return fmt(d.viewer.tooLarge, { size: (bytes.size / MB).toFixed(1) })
  }
  return d.viewer.unreadable
}
