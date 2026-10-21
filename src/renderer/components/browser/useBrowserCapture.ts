import type { Dict } from '@shared/app/dict'
import { PASSKEY_NOTICE_PREFIX } from '@shared/browser/passkeyGuard'
import type { PickBox, PickCapture, PickTheme } from '@shared/browser/pick'
import type { RegionCapture, RegionView } from '@shared/browser/regionCapture'
import type { WebviewTag } from 'electron'
import { type MutableRefObject, useCallback, useEffect, useState } from 'react'
import { useAgentTargets, useNoAgentsText } from '@/components/agents/PickSendPanel'
import type { PickTarget } from '@/lib/agents/pickTargets'
import { sendPickToPane, sendRegionToPane } from '@/lib/agents/sendPick'
import { fmt } from '@/lib/app/useDict'
import { useTransientStatus } from '@/lib/app/useTransientStatus'
import { registerRegionCapture } from '@/lib/browser/regionCaptures'
import { useSettingsStore } from '@/stores/app/settingsStore'

const STATUS_MS = 6000

function pickTheme(): PickTheme {
  const css = getComputedStyle(document.documentElement)
  const read = (name: string): string => css.getPropertyValue(name).trim()
  return { accent: read('--brand'), surface: read('--surface-3'), fg: read('--fg') }
}

interface BrowserCaptureParams {
  workspaceId: string
  paneId: string
  partition: string | null
  webviewRef: MutableRefObject<HTMLElement | null>
  withGuest: (fn: (wv: WebviewTag) => void) => boolean
  d: Dict
}

export function useBrowserCapture({
  workspaceId,
  paneId,
  partition,
  webviewRef,
  withGuest,
  d,
}: BrowserCaptureParams) {
  const [picking, setPicking] = useState<{ byAgent: boolean } | null>(null)
  const [capture, setCapture] = useState<PickCapture | null>(null)
  const [cropping, setCropping] = useState(false)
  const [region, setRegion] = useState<RegionCapture | null>(null)
  const [sending, setSending] = useState(false)
  const [status, setStatus] = useTransientStatus(STATUS_MS)
  const targets = useAgentTargets(workspaceId)
  const noTargets = useNoAgentsText(workspaceId)

  useEffect(
    () =>
      window.ostia.browser.onPickState((state) => {
        if (state.paneId !== paneId) return
        setPicking(state.active ? { byAgent: state.byAgent } : null)
      }),
    [paneId],
  )

  useEffect(() => {
    const el = webviewRef.current
    if (!el || !partition) return
    const onConsole = (e: Event): void => {
      const { message } = e as unknown as { message?: string }
      if (message?.startsWith(PASSKEY_NOTICE_PREFIX)) setStatus(d.browser.passkeyUnsupported)
    }
    el.addEventListener('console-message', onConsole)
    return () => el.removeEventListener('console-message', onConsole)
  }, [partition, d.browser.passkeyUnsupported, webviewRef, setStatus])

  const startCrop = useCallback((): void => {
    window.ostia.browser.pickCancel(paneId)
    setCapture(null)
    setRegion(null)
    setStatus(null)
    setCropping(true)
  }, [paneId, setStatus])

  useEffect(() => registerRegionCapture(paneId, startCrop), [paneId, startCrop])

  const finishCrop = async (rect: PickBox, view: RegionView): Promise<void> => {
    setCropping(false)
    const outcome = await window.ostia.browser.regionCapture(paneId, { rect, view })
    if (outcome.ok) setRegion(outcome.capture)
    else setStatus(fmt(d.browser.regionFailed, { reason: outcome.error }))
  }

  const copyRegion = async (): Promise<void> => {
    if (!region) return
    const res = await window.ostia.browser.regionCopy(paneId, region.id)
    if (res.ok) {
      setRegion(null)
      setStatus(d.browser.imageCopied)
    } else {
      setStatus(fmt(d.browser.imageCopyFailed, { reason: res.error }))
    }
  }

  const togglePick = async (): Promise<void> => {
    if (picking) {
      window.ostia.browser.pickCancel(paneId)
      return
    }
    setCapture(null)
    setRegion(null)
    setCropping(false)
    setStatus(null)
    setPicking({ byAgent: false })
    withGuest((wv) => wv.focus())
    const outcome = await window.ostia.browser.pickStart(paneId, pickTheme())
    setPicking(null)
    if (outcome.ok) setCapture(outcome.capture)
    else if (outcome.error !== 'cancelled' && outcome.error !== 'busy') {
      setStatus(fmt(d.browser.pickFailed, { reason: outcome.error }))
    }
  }

  const send = async (target: PickTarget, note: string): Promise<void> => {
    if (!capture && !region) return
    setSending(true)
    try {
      const opts = {
        sourcePaneId: paneId,
        targetPaneId: target.paneId,
        via: target.via,
        note,
        attachImage: useSettingsStore.getState().browser.attachCaptureImage,
      }
      const res = region
        ? await sendRegionToPane({ ...opts, capture: region })
        : capture
          ? await sendPickToPane({ ...opts, capture })
          : null
      if (!res) return
      if (res.ok) {
        setCapture(null)
        setRegion(null)
        setStatus(
          fmt(res.inserted ? d.send.sentInserted : d.send.sentCopied, { pane: target.title }),
        )
      } else {
        setStatus(fmt(d.send.sendFailed, { reason: res.error }))
      }
    } finally {
      setSending(false)
    }
  }

  return {
    picking,
    capture,
    setCapture,
    cropping,
    setCropping,
    region,
    setRegion,
    sending,
    status,
    setStatus,
    targets,
    noTargets,
    startCrop,
    finishCrop,
    copyRegion,
    togglePick,
    send,
  }
}
