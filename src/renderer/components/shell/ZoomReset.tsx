import { Hint } from '@/components/common/Hint'
import { Button } from '@/components/ui/button'
import { useDict } from '@/i18n/useDict'
import { useReducedMotion } from '@/lib/app/motion'
import { activeZoom, resetZoom } from '@/lib/app/wheelZoom'
import { useSettingsStore } from '@/stores/settingsStore'
import { MagnifyingGlassMinusIcon, MagnifyingGlassPlusIcon } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'

export const ZOOM_CHIP_EXIT_MS = 105

function ZoomFace({ percent }: { percent: number }): JSX.Element {
  const Icon = percent < 100 ? MagnifyingGlassMinusIcon : MagnifyingGlassPlusIcon
  return (
    <>
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="tabular-nums">{percent}%</span>
    </>
  )
}

function useLeavingPercent(percent: number | null): number | null {
  const reduced = useReducedMotion()
  const last = useRef<number | null>(percent)
  const [leaving, setLeaving] = useState<number | null>(null)

  useEffect(() => {
    const previous = last.current
    last.current = percent
    if (percent !== null || previous === null || reduced) {
      setLeaving(null)
      return
    }
    setLeaving(previous)
    const timer = window.setTimeout(() => setLeaving(null), ZOOM_CHIP_EXIT_MS)
    return () => window.clearTimeout(timer)
  }, [percent, reduced])

  return percent === null ? leaving : null
}

export function ZoomReset(): JSX.Element | null {
  const d = useDict()
  const percent = useSettingsStore((s) => activeZoom(s.appearance))
  const leaving = useLeavingPercent(percent)

  if (percent === null) {
    if (leaving === null) return null
    return (
      <span className="zoom-chip" data-leaving="" aria-hidden>
        <ZoomFace percent={leaving} />
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
