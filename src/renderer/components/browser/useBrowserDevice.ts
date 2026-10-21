import type { BrowserDevice } from '@shared/browser/browserDevice'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'

const OFF = 'off'

export interface BrowserDeviceControls {
  device: BrowserDevice | undefined
  preview: (next: BrowserDevice) => void
  commit: (next: BrowserDevice | null) => void
}

export function useBrowserDevice({
  workspaceId,
  paneId,
  saved,
  readyWebview,
}: {
  workspaceId: string
  paneId: string
  saved: BrowserDevice | undefined
  readyWebview: HTMLElement | null
}): BrowserDeviceControls {
  const [draft, setDraft] = useState<BrowserDevice | null>(null)
  const sent = useRef<{ guest: HTMLElement | null; key: string }>({ guest: null, key: OFF })

  useEffect(() => {
    if (!readyWebview) return
    const key = saved ? JSON.stringify(saved) : OFF
    const last = sent.current.guest === readyWebview ? sent.current.key : OFF
    sent.current = { guest: readyWebview, key }
    if (key !== last) void window.ostia.browser.setDevice(paneId, saved ?? null)
  }, [readyWebview, saved, paneId])

  const commit = useCallback(
    (next: BrowserDevice | null) => {
      setDraft(null)
      useLayoutStore.getState().setBrowserDevice(workspaceId, paneId, next)
    },
    [workspaceId, paneId],
  )

  return { device: saved ? (draft ?? saved) : undefined, preview: setDraft, commit }
}
