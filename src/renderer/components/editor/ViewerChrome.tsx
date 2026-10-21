import {
  ArrowsInIcon,
  MagnifyingGlassMinusIcon,
  MagnifyingGlassPlusIcon,
} from '@phosphor-icons/react'
import type { ReactNode } from 'react'
import { IconButton } from '@/components/common/IconButton'
import { formatBytes } from '@/lib/app/localeFormat'
import { fmt, useDict } from '@/lib/app/useDict'
import { stepZoom, zoomPercent } from '@/lib/browser/regionSelect'
import { archiveProblemText } from '@/lib/files/archiveProblems'
import type { FileBytes } from '@/lib/files/viewerHooks'
import { useSettingsStore } from '@/stores/app/settingsStore'

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

export function useBytesProblem(bytes: FileBytes): string | null {
  const d = useDict()
  const locale = useSettingsStore((s) => s.locale)
  if ('status' in bytes) return d.viewer.loading
  if (bytes.ok) return null
  if (bytes.error === 'too-large') {
    return fmt(d.viewer.tooLarge, { size: formatBytes(bytes.size, locale) })
  }
  if (bytes.error === 'archive') return archiveProblemText(d, bytes.reason)
  return d.viewer.unreadable
}
