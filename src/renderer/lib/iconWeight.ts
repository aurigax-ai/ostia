import type { IconWeight } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'

export const WHOLE_PIXEL_STROKE_SCALE = 2

export function iconWeightFor(scale: number): IconWeight {
  return scale < WHOLE_PIXEL_STROKE_SCALE ? 'bold' : 'regular'
}

export function useIconWeight(): IconWeight {
  const [scale, setScale] = useState(() => window.devicePixelRatio)
  useEffect(() => {
    const query = window.matchMedia(`(resolution: ${scale}dppx)`)
    const update = (): void => setScale(window.devicePixelRatio)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [scale])
  return iconWeightFor(scale)
}
