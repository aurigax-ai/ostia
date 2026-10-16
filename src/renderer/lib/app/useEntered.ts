import { useState } from 'react'

export function useEntered(keys: readonly string[]): ReadonlySet<string> {
  const [seen, setSeen] = useState(keys)
  const [entered, setEntered] = useState<ReadonlySet<string>>(new Set())
  if (keys.length !== seen.length || keys.some((key, i) => key !== seen[i])) {
    setSeen(keys)
    setEntered(new Set(keys.filter((key) => !seen.includes(key))))
  }
  return entered
}
