import type { Region } from '@shared/browser/selection'
import { type PointerEvent, useEffect, useRef, useState } from 'react'
import { MenuItem } from '@/components/common/Menu'
import { SplitButton, SplitButtonMenu } from '@/components/common/SplitButton'
import { Button } from '@/components/ui/button'
import { useDict } from '@/lib/app/useDict'

const REGION_MIN = 4

export type RegionAction = 'send' | 'copy'

export interface PickedRegion {
  region: Region
  viewWidth: number
  viewHeight: number
}

export function PreviewRegionTools({
  onPick,
}: {
  onPick: (action: RegionAction) => void
}): JSX.Element {
  const d = useDict()
  return (
    <div className="preview-tools">
      <SplitButton
        label={d.preview.regionActions}
        variant="outline"
        main={
          <Button variant="outline" size="xs" onClick={() => onPick('send')}>
            {d.preview.sendRegion}
          </Button>
        }
      >
        <SplitButtonMenu label={d.preview.regionActions} size="xs" variant="outline">
          <MenuItem onClick={() => onPick('copy')}>{d.preview.copyRegion}</MenuItem>
        </SplitButtonMenu>
      </SplitButton>
    </div>
  )
}

function inside(rect: DOMRect, x: number, y: number): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
}

export function PreviewRegionOverlay({
  onDone,
}: {
  onDone: (picked: PickedRegion | null) => void
}): JSX.Element {
  const d = useDict()
  const ref = useRef<HTMLDivElement>(null)
  const [start, setStart] = useState<[number, number] | null>(null)
  const [box, setBox] = useState<Region | null>(null)
  const doneRef = useRef(onDone)
  doneRef.current = onDone

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      doneRef.current(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  useEffect(() => {
    if (!start) return
    const layer = ref.current
    const regionTo = (x: number, y: number): Region | null => {
      if (!layer) return null
      const rect = layer.getBoundingClientRect()
      const [sx, sy] = [start[0] - rect.left, start[1] - rect.top]
      const [ex, ey] = [x - rect.left, y - rect.top]
      return {
        x: Math.round(Math.min(sx, ex)),
        y: Math.round(Math.min(sy, ey)),
        width: Math.round(Math.abs(ex - sx)),
        height: Math.round(Math.abs(ey - sy)),
      }
    }
    const onMove = (e: MouseEvent): void => setBox(regionTo(e.clientX, e.clientY))
    const onUp = (e: MouseEvent): void => {
      const region = regionTo(e.clientX, e.clientY)
      const ok =
        layer !== null &&
        region !== null &&
        inside(layer.getBoundingClientRect(), e.clientX, e.clientY) &&
        region.width >= REGION_MIN &&
        region.height >= REGION_MIN
      doneRef.current(
        ok && layer && region
          ? { region, viewWidth: layer.clientWidth, viewHeight: layer.clientHeight }
          : null,
      )
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [start])

  return (
    <div
      ref={ref}
      className="preview-region"
      data-testid="preview-region"
      role="presentation"
      title={d.preview.regionHint}
      onPointerDown={(e: PointerEvent<HTMLDivElement>) => {
        e.preventDefault()
        setStart([e.clientX, e.clientY])
      }}
    >
      {box ? (
        <div
          className="preview-region-box"
          style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
        />
      ) : null}
    </div>
  )
}
