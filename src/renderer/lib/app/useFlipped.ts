import { useEffect, useRef } from 'react'

type Flags = Readonly<Record<string, boolean>>

const NONE: ReadonlySet<string> = new Set()

export function useFlipped(flags: Flags): ReadonlySet<string> {
  const before = useRef(flags)
  const shown = useRef(NONE)
  const fresh = Object.keys(flags).filter(
    (key) => key in before.current && before.current[key] !== flags[key],
  )
  const flipped = fresh.length > 0 ? new Set(fresh) : shown.current
  useEffect(() => {
    before.current = flags
    shown.current = flipped
  })
  return flipped
}
