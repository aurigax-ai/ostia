import { MagnifyingGlassMinusIcon, MagnifyingGlassPlusIcon } from '@phosphor-icons/react'
import type { JSX } from 'react'
import { Hint } from '@/components/common/Hint'
import { Button } from '@/components/ui/button'
import { useDict } from '@/lib/app/useDict'
import { useExitPresence } from '@/lib/app/useExitPresence'
import { activeZoom, resetZoom } from '@/lib/app/wheelZoom'
import { useSettingsStore } from '@/stores/app/settingsStore'

function ZoomFace({ percent }: { percent: number }): JSX.Element {
  const Icon = percent < 100 ? MagnifyingGlassMinusIcon : MagnifyingGlassPlusIcon
  return (
    <>
      <Icon className="size-4 shrink-0" aria-hidden />
      <span className="tabular-nums">{percent}%</span>
    </>
  )
}

export function ZoomReset(): JSX.Element | null {
  const d = useDict()
  const percent = useSettingsStore((s) => activeZoom(s.appearance))
  const zoom = useExitPresence(percent)

  if (percent === null) {
    if (zoom.shown === null) return null
    return (
      <span className="zoom-chip" data-leaving="" aria-hidden onAnimationEnd={zoom.onExited}>
        <ZoomFace percent={zoom.shown} />
      </span>
    )
  }
  return (
    <Hint label={d.topbar.resetZoom} command="view.zoomReset" side="bottom">
      <Button
        variant="ghost"
        size="xs"
        aria-label={d.topbar.resetZoom}
        className="zoom-chip"
        onClick={resetZoom}
      >
        <ZoomFace percent={percent} />
      </Button>
    </Hint>
  )
}
