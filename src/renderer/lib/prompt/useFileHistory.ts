import type { ShellHistoryEntry } from '@shared/types'
import { useEffect, useState } from 'react'

const NONE: ShellHistoryEntry[] = []

interface Loaded {
  paneId: string
  entries: ShellHistoryEntry[]
}

export function useFileHistory(
  paneId: string | null,
  active: boolean,
  prompt: unknown = null,
): ShellHistoryEntry[] {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const have = loaded !== null && loaded.paneId === paneId

  useEffect(() => {
    void prompt
    if (!active || !paneId || have) return
    let live = true
    window.ostia.pty
      .history(paneId)
      .then((entries) => {
        if (live && entries.length > 0) setLoaded({ paneId, entries })
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [paneId, active, have, prompt])

  return active && loaded && loaded.paneId === paneId ? loaded.entries : NONE
}
