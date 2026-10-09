import { useCallback, useState } from 'react'

export interface ExitPresence<T> {
  shown: T | null
  leaving: boolean
  onExited: () => void
}

export function useExitPresence<T>(value: T | null): ExitPresence<T> {
  const [last, setLast] = useState<T | null>(value)
  if (value !== null && value !== last) setLast(value)
  const onExited = useCallback(() => setLast(null), [])
  return { shown: value ?? last, leaving: value === null && last !== null, onExited }
}
