import { type Dispatch, type SetStateAction, useEffect, useState } from 'react'

export function useTransientStatus(
  ms: number,
): [string | null, Dispatch<SetStateAction<string | null>>] {
  const [status, setStatus] = useState<string | null>(null)
  useEffect(() => {
    if (!status) return
    const timer = setTimeout(() => setStatus(null), ms)
    return () => clearTimeout(timer)
  }, [status, ms])
  return [status, setStatus]
}
