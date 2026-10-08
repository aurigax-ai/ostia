import type { IconWeight } from '@phosphor-icons/react'
import { useEffect, useMemo, useState } from 'react'

export function iconWeight(devicePixelRatio: number): IconWeight {
  const whole = Math.round(devicePixelRatio)
  const onGrid = Math.abs(devicePixelRatio - whole) < 0.01 && whole >= 2 && whole % 2 === 0
  return onGrid ? 'regular' : 'bold'
}

export function useIconStyle(): { weight: IconWeight } {
  const [ratio, setRatio] = useState(() => window.devicePixelRatio)
  useEffect(() => {
    const query = window.matchMedia(`(resolution: ${ratio}dppx)`)
    const update = (): void => setRatio(window.devicePixelRatio)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [ratio])
  const weight = iconWeight(ratio)
  return useMemo(() => ({ weight }), [weight])
}
