import type { Dict } from '@shared/app/dict'
import { PASSKEY_NOTICE_PREFIX } from '@shared/browser/passkeyGuard'
import type { PickBox, PickTheme } from '@shared/browser/pick'
import type { RegionView } from '@shared/browser/regionCapture'
import type { WebviewTag } from 'electron'
import { type MutableRefObject, useCallback, useEffect, useState } from 'react'
import { fmt } from '@/lib/app/useDict'
import { pageTextAdapter, pickAdapter, regionAdapter } from '@/lib/browser/captureAdapters'
import { layerRectAnchor, pageBoxAnchor, pageBoxToLayer } from '@/lib/browser/captureAnchor'
import { registerRegionCapture } from '@/lib/browser/regionCaptures'
import {
  closeCapture,
  openCapture,
  registerCaptureOpener,
  setCaptureStatus,
} from '@/lib/capture/captureSession'

function pickTheme(): PickTheme {
  const css = getComputedStyle(document.documentElement)
  const read = (name: string): string => css.getPropertyValue(name).trim()
  return { accent: read('--brand'), surface: read('--surface-3'), fg: read('--fg') }
}

interface BrowserCaptureParams {
  paneId: string
  partition: string | null
  webviewRef: MutableRefObject<HTMLElement | null>
  withGuest: (fn: (wv: WebviewTag) => void) => boolean
  d: Dict
}

export function useBrowserCapture({
  paneId,
  partition,
  webviewRef,
  withGuest,
  d,
}: BrowserCaptureParams) {
  const [picking, setPicking] = useState<{ byAgent: boolean } | null>(null)
  const [cropping, setCropping] = useState(false)

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
      if (message?.startsWith(PASSKEY_NOTICE_PREFIX)) {
        setCaptureStatus(paneId, d.browser.passkeyUnsupported)
      }
    }
    el.addEventListener('console-message', onConsole)
    return () => el.removeEventListener('console-message', onConsole)
  }, [paneId, partition, d.browser.passkeyUnsupported, webviewRef])

  const startCrop = useCallback((): void => {
    window.ostia.browser.pickCancel(paneId)
    closeCapture(paneId, 'replaced')
    setCaptureStatus(paneId, null)
    setCropping(true)
  }, [paneId])

  useEffect(() => registerRegionCapture(paneId, startCrop), [paneId, startCrop])

  const finishCrop = async (rect: PickBox, view: RegionView, layerRect: PickBox): Promise<void> => {
    setCropping(false)
    const outcome = await window.ostia.browser.regionCapture(paneId, { rect, view })
    if (!outcome.ok) {
      setCaptureStatus(paneId, fmt(d.browser.regionFailed, { reason: outcome.error }))
      return
    }
    const wv = webviewRef.current
    openCapture(
      paneId,
      regionAdapter({ paneId, d, anchor: wv && layerRectAnchor(wv, layerRect) }, outcome.capture, {
        rect: layerRect,
        sized: true,
      }),
    )
  }

  const togglePick = async (): Promise<void> => {
    if (picking) {
      window.ostia.browser.pickCancel(paneId)
      return
    }
    closeCapture(paneId, 'replaced')
    setCropping(false)
    setCaptureStatus(paneId, null)
    setPicking({ byAgent: false })
    withGuest((wv) => wv.focus())
    const outcome = await window.ostia.browser.pickStart(paneId, pickTheme())
    setPicking(null)
    if (outcome.ok) {
      const wv = webviewRef.current
      const { capture } = outcome
      const rect = wv && pageBoxToLayer(wv, capture.box, capture.viewport)
      openCapture(
        paneId,
        pickAdapter(
          { paneId, d, anchor: wv && pageBoxAnchor(wv, capture.box, capture.viewport) },
          capture,
          rect ? { rect, sized: false } : null,
        ),
      )
    } else if (outcome.error !== 'cancelled' && outcome.error !== 'busy') {
      setCaptureStatus(paneId, fmt(d.browser.pickFailed, { reason: outcome.error }))
    }
  }

  const openPageSelection = useCallback(async (): Promise<void> => {
    const selection = await window.ostia.browser.pageSelection(paneId)
    if (!selection) {
      setCaptureStatus(paneId, d.viewer.noSelection)
      return
    }
    window.ostia.browser.pickCancel(paneId)
    setCropping(false)
    const wv = webviewRef.current
    openCapture(
      paneId,
      pageTextAdapter(
        { paneId, d, anchor: wv && pageBoxAnchor(wv, selection.box, selection.viewport) },
        selection,
      ),
    )
  }, [paneId, webviewRef, d])

  useEffect(
    () => registerCaptureOpener(paneId, () => void openPageSelection()),
    [paneId, openPageSelection],
  )

  return { picking, cropping, setCropping, startCrop, finishCrop, togglePick }
}
