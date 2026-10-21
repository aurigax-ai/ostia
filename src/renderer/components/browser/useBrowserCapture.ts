import type { Dict } from '@shared/app/dict'
import { PASSKEY_NOTICE_PREFIX } from '@shared/browser/passkeyGuard'
import type { PickBox, PickCapture, PickCopyResult, PickTheme } from '@shared/browser/pick'
import type { RegionCapture, RegionView } from '@shared/browser/regionCapture'
import type { PageSelection } from '@shared/browser/selection'
import type { WebviewTag } from 'electron'
import { type MutableRefObject, useCallback, useEffect, useState } from 'react'
import type { BarAnchor } from '@/lib/agents/barAnchor'
import type { PickTarget } from '@/lib/agents/pickTargets'
import { registerSelectionCopier } from '@/lib/agents/selectionCopiers'
import { registerSelectionSender } from '@/lib/agents/selectionSenders'
import { sendPickToPane, sendRegionToPane, sendSelectionToPane } from '@/lib/agents/sendPick'
import { fmt } from '@/lib/app/useDict'
import { useTransientStatus } from '@/lib/app/useTransientStatus'
import { layerRectAnchor, pageBoxAnchor } from '@/lib/browser/captureAnchor'
import { registerRegionCapture } from '@/lib/browser/regionCaptures'
import { useSettingsStore } from '@/stores/app/settingsStore'

const STATUS_MS = 6000

type OpenCapture =
  | { kind: 'pick'; capture: PickCapture }
  | { kind: 'region'; capture: RegionCapture }
  | { kind: 'text'; selection: PageSelection }

function pickCopyStatus(d: Dict, res: PickCopyResult): string {
  if (!res.ok) throw new Error(fmt(d.browser.pickCopyFailed, { reason: res.error }))
  if (res.kind === 'table') {
    return fmt(d.browser.pickCopiedTable, { rows: res.rows, columns: res.columns })
  }
  return res.kind === 'image' ? d.browser.pickCopiedImage : d.browser.pickCopiedReport
}

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

interface CaptureBarState {
  key: number
  open: OpenCapture
  anchor: BarAnchor
}

let barCounter = 0

function barOf(open: OpenCapture, anchor: BarAnchor | null): CaptureBarState {
  barCounter += 1
  return { key: barCounter, open, anchor: anchor ?? FALLBACK_ANCHOR }
}

const FALLBACK_ANCHOR: BarAnchor = { left: 12, top: 12, bottom: 12 }

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
  const [bar, setBar] = useState<CaptureBarState | null>(null)
  const [status, setStatus] = useTransientStatus(STATUS_MS)

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

  const closeBar = useCallback((): void => setBar(null), [])

  const startCrop = useCallback((): void => {
    window.ostia.browser.pickCancel(paneId)
    setBar(null)
    setStatus(null)
    setCropping(true)
  }, [paneId, setStatus])

  useEffect(() => registerRegionCapture(paneId, startCrop), [paneId, startCrop])

  const finishCrop = async (rect: PickBox, view: RegionView, layerRect: PickBox): Promise<void> => {
    setCropping(false)
    const outcome = await window.ostia.browser.regionCapture(paneId, { rect, view })
    if (!outcome.ok) {
      setStatus(fmt(d.browser.regionFailed, { reason: outcome.error }))
      return
    }
    const wv = webviewRef.current
    setBar(
      barOf({ kind: 'region', capture: outcome.capture }, wv && layerRectAnchor(wv, layerRect)),
    )
  }

  const togglePick = async (): Promise<void> => {
    if (picking) {
      window.ostia.browser.pickCancel(paneId)
      return
    }
    setBar(null)
    setCropping(false)
    setStatus(null)
    setPicking({ byAgent: false })
    withGuest((wv) => wv.focus())
    const outcome = await window.ostia.browser.pickStart(paneId, pickTheme())
    setPicking(null)
    if (outcome.ok) {
      const wv = webviewRef.current
      const { capture } = outcome
      setBar(
        barOf({ kind: 'pick', capture }, wv && pageBoxAnchor(wv, capture.box, capture.viewport)),
      )
    } else if (outcome.error !== 'cancelled' && outcome.error !== 'busy') {
      setStatus(fmt(d.browser.pickFailed, { reason: outcome.error }))
    }
  }

  const openPageSelection = useCallback(async (): Promise<void> => {
    const selection = await window.ostia.browser.pageSelection(paneId)
    if (!selection) {
      setStatus(d.viewer.noSelection)
      return
    }
    window.ostia.browser.pickCancel(paneId)
    setCropping(false)
    const wv = webviewRef.current
    setBar(
      barOf(
        { kind: 'text', selection },
        wv && pageBoxAnchor(wv, selection.box, selection.viewport),
      ),
    )
  }, [paneId, webviewRef, setStatus, d.viewer.noSelection])

  useEffect(
    () => registerSelectionSender(paneId, () => void openPageSelection()),
    [paneId, openPageSelection],
  )

  const copyOpen = useCallback(
    async (open: OpenCapture): Promise<string> => {
      if (open.kind === 'pick') {
        return pickCopyStatus(d, await window.ostia.browser.pickCopy(paneId, open.capture.id))
      }
      if (open.kind === 'region') {
        const res = await window.ostia.browser.regionCopy(paneId, open.capture.id)
        if (!res.ok) throw new Error(fmt(d.browser.imageCopyFailed, { reason: res.error }))
        return d.browser.imageCopied
      }
      const written = await window.ostia.clipboard.writeCapture({
        text: open.selection.capture.text,
      })
      if (!written) throw new Error(d.send.copyFailed)
      return d.send.copied
    },
    [paneId, d],
  )

  const openBar = bar?.open ?? null
  useEffect(() => {
    if (!openBar) return
    return registerSelectionCopier(paneId, () =>
      copyOpen(openBar)
        .then(setStatus, (e: unknown) => setStatus(messageOf(e)))
        .finally(closeBar),
    )
  }, [openBar, paneId, copyOpen, setStatus, closeBar])

  const copyBar = (): Promise<string | null> => (bar ? copyOpen(bar.open) : Promise.resolve(null))

  const sendBar = async (target: PickTarget, note: string): Promise<void> => {
    if (!bar) return
    const { open } = bar
    const route = { sourcePaneId: paneId, targetPaneId: target.paneId, via: target.via, note }
    const attachImage = useSettingsStore.getState().browser.attachCaptureImage
    const res =
      open.kind === 'region'
        ? await sendRegionToPane({ ...route, attachImage, capture: open.capture })
        : open.kind === 'pick'
          ? await sendPickToPane({ ...route, attachImage, capture: open.capture })
          : await sendSelectionToPane({ ...route, capture: open.selection.capture })
    if (!res.ok) throw new Error(fmt(d.send.sendFailed, { reason: res.error }))
    setStatus(fmt(res.inserted ? d.send.sentInserted : d.send.sentCopied, { pane: target.title }))
  }

  return {
    picking,
    cropping,
    setCropping,
    status,
    setStatus,
    bar,
    closeBar,
    startCrop,
    finishCrop,
    togglePick,
    copyBar,
    sendBar,
  }
}
