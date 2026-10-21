import type { WebviewTag } from 'electron'
import { type Dispatch, type MutableRefObject, type SetStateAction, useEffect } from 'react'
import { guestReached } from '@/lib/panes/guestReached'
import { terminalTitle } from '@/lib/terminal/terminalTitle'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import type { FindResult } from './BrowserFind'

interface WebviewEventsParams {
  workspaceId: string
  paneId: string
  partition: string | null
  webviewRef: MutableRefObject<HTMLElement | null>
  readyRef: MutableRefObject<boolean>
  srcRef: MutableRefObject<string>
  staleSrcRef: MutableRefObject<string | null>
  pendingUrlRef: MutableRefObject<string | null>
  lastAppliedUrlRef: MutableRefObject<string>
  withGuest: (fn: (wv: WebviewTag) => void) => boolean
  load: (next: string) => void
  showAddress: (next: string) => void
  setCanGoBack: (value: boolean) => void
  setCanGoForward: (value: boolean) => void
  setNavCount: Dispatch<SetStateAction<number>>
  setLoadError: (error: { url: string; reason: string } | null) => void
  setFindResult: (result: FindResult | null) => void
}

export function useWebviewEvents({
  workspaceId,
  paneId,
  partition,
  webviewRef,
  readyRef,
  srcRef,
  staleSrcRef,
  pendingUrlRef,
  lastAppliedUrlRef,
  withGuest,
  load,
  showAddress,
  setCanGoBack,
  setCanGoForward,
  setNavCount,
  setLoadError,
  setFindResult,
}: WebviewEventsParams): void {
  useEffect(() => {
    const el = webviewRef.current
    if (!el || !partition) return

    const syncNavState = (): void => {
      const ok = withGuest((wv) => {
        setCanGoBack(wv.canGoBack())
        setCanGoForward(wv.canGoForward())
      })
      if (!ok) {
        setCanGoBack(false)
        setCanGoForward(false)
      }
    }
    const onNavigate = (e: Event): void => {
      const { url: navigatedUrl, isMainFrame } = e as unknown as {
        url: string
        isMainFrame?: boolean
      }
      if (isMainFrame === false) return
      setNavCount((n) => n + 1)
      setLoadError(null)
      showAddress(navigatedUrl)
      syncNavState()
      lastAppliedUrlRef.current = navigatedUrl
      useLayoutStore.getState().setUrl(workspaceId, paneId, navigatedUrl)
    }
    const onFailLoad = (e: Event): void => {
      const failed = e as unknown as {
        errorCode: number
        errorDescription: string
        validatedURL: string
        isMainFrame: boolean
      }
      if (failed.errorCode === -3 || !failed.isMainFrame) return
      showAddress(failed.validatedURL)
      setLoadError({
        url: failed.validatedURL,
        reason: failed.errorDescription || String(failed.errorCode),
      })
      syncNavState()
    }
    const onTitle = (e: Event): void => {
      const title = terminalTitle((e as unknown as { title: string }).title ?? '')
      if (title) useLayoutStore.getState().setTitle(workspaceId, paneId, title)
    }

    el.addEventListener('did-navigate', onNavigate)
    el.addEventListener('did-navigate-in-page', onNavigate)
    el.addEventListener('did-fail-load', onFailLoad)
    el.addEventListener('page-title-updated', onTitle)
    return () => {
      el.removeEventListener('page-title-updated', onTitle)
      el.removeEventListener('did-navigate', onNavigate)
      el.removeEventListener('did-navigate-in-page', onNavigate)
      el.removeEventListener('did-fail-load', onFailLoad)
    }
  }, [
    workspaceId,
    paneId,
    withGuest,
    showAddress,
    partition,
    webviewRef,
    setCanGoBack,
    setCanGoForward,
    setNavCount,
    setLoadError,
    lastAppliedUrlRef,
  ])

  useEffect(() => {
    const el = webviewRef.current
    if (!el || !partition) return
    readyRef.current = false
    const onDomReady = (): void => {
      readyRef.current = true
      const stale = staleSrcRef.current
      staleSrcRef.current = null
      withGuest((wv) => wv.setZoomFactor(useSettingsStore.getState().browser.defaultZoom / 100))
      withGuest((wv) => window.ostia.browser.register(paneId, wv.getWebContentsId()))
      withGuest((wv) => {
        if (stale !== null && wv.getURL() === stale) pendingUrlRef.current ??= srcRef.current
      })
      const pending = pendingUrlRef.current
      if (pending) load(pending)
    }
    el.addEventListener('dom-ready', onDomReady)
    if (guestReached(el)) onDomReady()
    return () => {
      el.removeEventListener('dom-ready', onDomReady)
      window.ostia.browser.unregister(paneId)
    }
  }, [paneId, withGuest, load, partition, webviewRef, readyRef, staleSrcRef, pendingUrlRef, srcRef])

  useEffect(() => {
    const el = webviewRef.current
    if (!el || !partition) return
    const onFound = (e: Event): void => {
      const { result } = e as unknown as {
        result: { activeMatchOrdinal: number; matches: number; finalUpdate: boolean }
      }
      if (result.finalUpdate)
        setFindResult({ active: result.activeMatchOrdinal, total: result.matches })
    }
    el.addEventListener('found-in-page', onFound)
    return () => el.removeEventListener('found-in-page', onFound)
  }, [partition, webviewRef, setFindResult])
}
