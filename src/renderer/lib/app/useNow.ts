import { useEffect, useState } from 'react'

export function useNow(intervalMs: number, enabled = true): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!enabled) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [enabled, intervalMs])
  return now
}
